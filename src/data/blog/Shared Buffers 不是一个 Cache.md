---
author: Neil Chen
pubDatetime: 2026-08-22T00:00:00+08:00
title: Shared Buffers 不是一个 Cache
description: Shared Buffers 会缓存 Page，但沿着一个 Buffer Slot 的生命周期看下去，里面还有 identity、pin、I/O、dirty 和 eviction 组成的一整套协议。
tags:
  - postgresql
  - internals
---

# Shared Buffers 不是一个 Cache

说到 PostgreSQL 的 `shared_buffers`，第一反应基本都是 Page Cache。

磁盘访问慢，那就拿一块共享内存，把常用的 Page 存起来。读 Page 先查缓存，命中直接用；没命中，再从磁盘读进来。空间不够了，就找个冷一点的 Page 踢出去。

这套理解干活够用。

不过顺着 Buffer Manager 的代码往下看，我发现只记住"Page Cache"四个字，很容易把很多东西看成零散的实现细节：

为什么一个 Page 还没读完，其他 Backend 就已经能够找到它？

为什么查到了 Buffer 以后还要 pin？

为什么 pin 住以后，访问 Page 内容又有一套 content lock？

一个 dirty Page 要离开 Shared Buffers，为什么还会牵扯到 WAL？

还有 CLOCK Sweep，看起来像是整个缓存淘汰算法的核心，结果它选出来的 Buffer，离真正能复用还差好几步。

把视角从 Page 稍微挪到 Buffer Slot 上，这些东西会连贯很多。

前几篇文章里，一个 Backend 总算住进了共享内存，也学会了等待和睡觉。它接下来打交道最多的，就是这块 Shared Buffers。

Shared Buffers 启动以后，那些 Slot 就已经存在了。比如 `buf_id = 17` 的 Slot，它今天可以装 relation A 的 block 42，过一阵又可能被拿去装 relation B 的 block 781。

```text
Buffer Slot 17

relation A / block 42
        ↓
   eviction
        ↓
relation B / block 781
```

Slot 一直是那个 Slot。

变化的是它当前承载哪个磁盘 Page。

Buffer Manager 很大一部分复杂性，就发生在这段绑定关系的建立、使用和解除过程中。

## 先让这个 Slot 有个名字

一个 Backend 想读取 relation A 的 block 42，首先得知道一件事：这个 Page 是不是已经有人读进 Shared Buffers 了？

PostgreSQL 用 `BufferTag` 表示磁盘 Page 的身份，里面装着 tablespace、database、relation、fork 和 block number。另有一张 mapping table，维护着这样的对应关系：

```text
BufferTag -> buf_id
```

这样，所有 Backend 对同一个磁盘 Page，都能找到同一个 Buffer Slot。

这里有个并发场景，值得停下来看一眼。

Backend A 和 Backend B 同时读取 block 42。假如 A 先分到了 Slot 17，然后直接去做磁盘 I/O，等 Page 全部读完以后才把它登记进 mapping table，那么在这段时间里，B 也会看到一次 miss。

```text
Backend A                   Backend B

lookup miss                 lookup miss

Slot 17                     Slot 63

read block 42               read block 42
```

同一个磁盘 Page，在内存里就有了两份。

后面谁改、谁变 dirty、谁负责写回，全都说不清了。

PG 的顺序因此有点特别。

它先给 Slot 安装 `BufferTag`，让这个 identity 进入 mapping table，然后才继续准备 Page 内容。

```text
找到一个 Slot
    ↓
安装 BufferTag
    ↓
进入 mapping table
    ↓
开始 read I/O
```

**也就是说，一个 Buffer 能被 lookup 到的时候，Page bytes 完全可能还没准备好。**

源码里也对应着两个状态：

```text
BM_TAG_VALID
BM_VALID
```

`BM_TAG_VALID` 说明这个 Slot 已经有合法的 Buffer identity。

`BM_VALID` 再往前一步，说明里面的 Page 内容已经可以使用。

这两个状态中间留出来的空间，刚好容纳了一次并发 I/O。

## 找到了以后，还要把它留住

mapping table 能让 Backend 找到 block 42 所在的 Slot。

但 Slot 会被复用。

Backend 刚刚查到：

```text
block 42 -> Slot 17
```

随后 Slot 17 要是被 replacement 拿走，重新绑定成 block 781，刚才拿到的信息就过期了。

所以查询到 Buffer 后还需要 pin。

只要 Buffer 仍然被 pin，replacement 就不能把这个 Slot 改成别的 Page。

想通这一层，我再看 pin 就顺眼多了：它防的，就是"刚查到、下一秒就变卦"这种场面。

**mapping table 建立的是全局可见的 Page 到 Slot 映射；pin 给当前使用者保留了这段映射的生命周期。**

同一个 Backend 重复 pin 同一个 Buffer 时，PG 还专门维护了一层 private refcount。第一次 pin 才增加 shared refcount，最后一次 unpin 才减少。

这个小设计挺有 PostgreSQL 的味道。

语义上需要一个引用计数，但没必要每次嵌套使用都去修改共享的 atomic state。**能留在 Backend 本地的计数，就尽量留在本地。**

## 大家都找到它了，Page 可能还在路上

刚才那个并发场景，现在按正确顺序继续往下走。

A 已经给 block 42 分到 Slot 17，identity 登记好以后才开始读磁盘。

这时 B 也来读 block 42，命中 mapping table，pin 到同一个 Slot 17。

到这里整个过程符合预期：系统里始终只有一个 block 42。

但 B 还不能读取 Page。

A 的 I/O 可能只进行了一半。

于是 `BM_TAG_VALID` 和 `BM_VALID` 之间又多了一层 I/O 状态：

```text
BM_TAG_VALID
    ↓
这个 Slot 已经属于 block 42

BM_IO_IN_PROGRESS
    ↓
有人正在准备 Page 内容

BM_VALID
    ↓
Page 可以使用
```

第一个 Backend 负责 I/O，后来者找到同一个 Buffer 后等待 I/O 完成。

这层状态关系，最近又多了一个用武之地。

PostgreSQL 的读路径也越来越多地建立在 AIO 基础设施上。一次 Page 读取，不一定再是 Backend 发起一次同步读取，然后原地等到完成。

ReadStream 可以提前准备后续 Page 的读取，Buffer Manager 通过 smgrstartreadv() 把请求交给 storage manager，等 completion 回来以后，再让对应 Buffer 进入 valid 状态。

I/O 怎么执行可以变，上面这套关系不会变。Shared Buffer 仍然要先建立唯一 identity，用 `BM_IO_IN_PROGRESS` 协调这次 I/O 的归属，真正完成以后才设置 `BM_VALID`。对其他 Backend 来说，看到的还是同一件事：**Page 已经有人负责了，但内容可能还在路上。**

这套安排一口气解决了两件事：identity 尽早公开，不会有人重复读同一个 Page；内容严格等 I/O 结束才开放，不会有人读到半截。

所以在 Buffer Manager 里，**"找到这个 Page"和"这个 Page 可以用了"之间，本来就存在一段状态转换。**

普通 Cache 的描述通常把这段过程折叠成一次 miss load，PG 则把里面的并发责任明明白白保留了下来。

## Pin 住了，Page 里面还是有人能改

等 `BM_VALID` 成立，Page 内容已经准备好了。

这时 pin 仍然只负责 Slot 的生命周期。

假设 A 和 B 都 pin 住 block 42，这很正常。两个人同时持有 pin，并不会互相排斥。

如果 A 准备修改 Page header、line pointer 或其他内容，它还要进入 Page contents 自己的并发协议。

这里就是 content lock。（是的，又是一种锁。）

```text
pin
    保证 Slot 继续承载当前 Page

content lock
    协调 Page bytes 的并发访问
```

两者经常一起出现，但持续时间和用途差别很大。

一个 Backend 可以在较长的代码路径里持有 pin，只在真正访问 Page 内容的临界区里拿 content lock。

如果把这几个状态放在一起看，一个所谓"在 Shared Buffers 里的 Page"，其实可能处于很多阶段：

```text
identity 已建立
content 还没读完

identity 已建立
content 已 valid
当前没人使用

被多个 Backend pin

有人持有 content lock 修改

已经 dirty

正在写回

等待被 eviction
```

平时说"这个 Page 在缓存里"当然没问题。

读源码的时候，这句话就显得有点粗了。

## Dirty 以后，多了一层持久化关系

Clean Buffer 处理起来相对轻松。

磁盘上已经有一份 Page，内存里这份只是副本，不要了，再读一遍就行。

Page 被修改以后，Shared Buffer 里就出现了更新的数据。

`MarkBufferDirty()` 会设置 `BM_DIRTY`，表示这块 Buffer 以后需要写回。

到这里又出现了几个容易混在一起的状态：

```text
BM_DIRTY
page LSN
WAL flush LSN
```

`BM_DIRTY` 记录 Buffer 是否需要写出。

page LSN 记录当前 Page 内容对应到哪个 WAL 位置。

WAL flush LSN 则表示 WAL 已经持久化到了哪里。

前台修改 Page 的时候，不需要马上把 Page 写回磁盘——反正修改已经记进 WAL 了，万一崩溃，也能从 WAL 重放回来。

所以一块 dirty Buffer 可以在 Shared Buffers 里待很久。

等某个 Backend、bgwriter 或 checkpointer 最终准备写它时，page LSN 才开始发挥一个很直接的作用：

```text
WAL flush LSN >= page LSN
        ↓
data page 可以安全写出
```

这样看，dirty 也不仅是 Cache 里常见的一个"内容被修改过"的标志。

它给这个 Buffer 增加了一层持久化约束：

> **Page 可以晚点写，但在离开内存之前，要满足 WAL-before-data。**

## CLOCK Sweep 只负责先挑一个

Shared Buffers 空间有限，最终总会遇到 replacement。

PostgreSQL 使用 CLOCK Sweep。

这部分单独看，很像标准 Cache 算法：

```text
refcount > 0
    跳过

usage_count > 0
    usage_count--
    继续

refcount == 0
usage_count == 0
    candidate
```

不过 `candidate` 这个词很重要。

CLOCK Sweep 找到的，只是一个现在看起来比较适合复用的 Slot。

它还没有离开当前 Page。

比如这个 Buffer 可能 dirty。

那么后面还要尝试拿合适的 content lock，把 Page 写出去。

如果 Page 属于 permanent relation，写 data page 以前可能还得先把 WAL flush 推过 page LSN。

即使 Page 已经写完，旧的 `BufferTag` 也不能立刻随便清掉。还要重新确认 refcount、dirty 状态和 mapping table，避免这段时间里其他 Backend 又 pin 或修改了它。

整个过程大致是：

```text
CLOCK 找到 candidate
        ↓
pin candidate
        ↓
检查当前状态
        ↓
dirty?
   ↓
尝试 content lock
   ↓
必要时 flush WAL
   ↓
write page
        ↓
重新确认可以 invalid
        ↓
删除旧 mapping
        ↓
清理旧 identity
        ↓
Slot 可以重新分配
```

任何一步发现条件已经变化，都可以放弃当前 candidate，再去找下一个。

所以 CLOCK Sweep 决定的主要是**"先看看谁"**。

一个 Slot 最终能不能结束当前生命周期，还要经过后面的清理协议。

这也解释了为什么 Buffer eviction 的代码会一路跨过 buffer manager、WAL、smgr 和 sync 等模块。

从数组里挑出一个冷 Slot 很便宜。

让它安全地结束当前 Page identity，代价就完全是另一回事了。

## 一个 Slot 的下一轮

旧 mapping 删除，原来的 `BufferTag` 被清理以后，Slot 又回到了可以复用的状态。

然后下一次 miss 到来：

```text
Slot 17

block 42
   ↓
write / invalidate
   ↓
旧 identity 消失
   ↓
安装新 BufferTag
   ↓
block 781
   ↓
read I/O
   ↓
valid
   ↓
被使用
   ↓
...
```

一块 Shared Buffer 就这样不断重复自己的生命周期。

站在 Page 的角度看，是 Page 被读进来、访问、淘汰。

站在 Slot 的角度看，会看到一段更完整的状态流转：

```text
绑定 Page identity
        ↓
让 identity 对其他 Backend 可见
        ↓
准备 Page contents
        ↓
维持使用期间的 Slot 生命周期
        ↓
协调 Page contents 的访问
        ↓
承担 dirty 后的持久化约束
        ↓
解除当前 identity
        ↓
等待下一次绑定
```

我现在再看 `BufferDesc.state` 里那一堆 refcount、usage count 和 `BM_*` flag，会觉得它们没那么像一堆零散状态了。

它们大多都能放回这个生命周期的某一个阶段。

## 顺序扫描也还是走 Shared Buffers

还有一个我挺喜欢的细节，是 `BufferAccessStrategy`。

假设顺序扫描一张远大于 `shared_buffers` 的表。

如果每个新读到的 Page 都像普通访问一样参与整个 Buffer Pool 的 replacement，扫描一路进行下去，很容易把原本的 OLTP 热页冲掉。

PG 给 Bulk Read 准备了一个较小的 ring。

扫描还是使用 Shared Buffers，也继续走 BufferTag、pin、I/O 这些协议。只是 allocation 时优先在自己的 ring 里循环复用一小批 Buffer。

```text
普通访问
    在整个 Shared Buffers 工作集里参与 replacement

Bulk Read
    仍使用 Shared Buffers
    但尽量在较小的 ring 中循环
```

刚被读过，并不天然代表值得长期留在 Shared Buffers。

一次大顺序扫描很可能知道得更多：这些 Page 大概率只会顺着读一遍，没必要为它们赶走现有的热工作集。

Buffer Manager 在决定 Page 去留的时候，把访问模式的全局影响也算进去了。

现在的顺序扫描还会把 `BufferAccessStrategy` 和 ReadStream/AIO 配合起来：ring 管住这次扫描对 Shared Buffers 工作集的影响，ReadStream 则负责把后面的 Page 更早送进 I/O 流水线。

## 再回头看这个 Cache

所以，`shared_buffers` 当然可以叫 Page Cache。

这个模型解释命中、miss 和减少磁盘访问，已经足够好。

继续往 Buffer Manager 里面走，就需要更多状态。

一个磁盘 Page 进入 Shared Buffers 后，会建立 identity；Backend 使用它时要维持 Slot 生命周期；Page contents 有自己的 I/O 和并发协议；修改以后又和 WAL durability 建立联系；最后 eviction 还要把这些关系逐层收干净。

`PageId -> Page` 只描述了其中很短的一截。

我现在更习惯从 Buffer Slot 的生命周期去看这套代码。

Shared Buffers 是一组不断复用的内存 Frame。

Buffer Manager 则负责让这些 Frame 在并发环境里稳定地承载一个磁盘 Page，并在合适的时候把这段关系安全解除。

这样再回去看 mapping、pin、`BM_VALID`、content lock、dirty 和 CLOCK Sweep，它们就都能找到自己的位置了。

标题说 Shared Buffers 不是一个 Cache，多少有点耍赖。

它当然是。

只不过读到这里以后，**"Cache"两个字已经不太够用了**。

下次再遇到什么诡异的 buffer 问题，我大概会先问一句：这个 Slot 现在走到哪一步了？
