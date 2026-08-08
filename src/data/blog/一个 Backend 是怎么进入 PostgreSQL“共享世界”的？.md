---
author: Neil Chen
pubDatetime: 2026-08-08T00:00:00+08:00
title: 一个 Backend 是怎么进入 PostgreSQL“共享世界”的？
description: 有了 PID，为什么还要 PGPROC？有了 PGPROC，为什么还要 ProcArray？顺着 backend 的生命周期，看它怎么在共享内存里建立身份、发布状态，再安全退场。
tags:
  - postgresql
  - internals
---

# 一个 Backend 是怎么进入 PostgreSQL“共享世界”的？

vacuum 一直在跑，表却越来越大。排障的人多半会先猜：某个老事务的 `xmin` 挡着。可“挡着”到底是怎么挡的，一个 backend 的 `xmin` 凭什么能拖住全库的清理？

还有 `pg_stat_activity` 里那个卡在等待里的 backend：它在等什么，该由谁来唤醒？

这些问题的答案，都不在进程自己的内存里。它们散落在 PostgreSQL 的 shared memory 中——一个 backend 需要把一部分状态“发布”出去，让别的进程能找到它、观察它、等待它。

之前聊过一点pg的共享内存，这篇顺着 backend 从出生到退出的整个生命周期，看看它是怎么一步步进入这个“共享世界”的。

一个客户端连接进来，postmaster 就 fork 出一个 backend。

从操作系统的角度看，这个新进程的身份已经很明确了：一个 PID。

那为什么 PostgreSQL 还要在 shared memory 里提前准备一批 `PGPROC`？

不止如此。backend 启动以后，还要先通过 `InitProcess()` 领走一个 `PGPROC`，拿到 `MyProc` 和 `MyProcNumber`；紧接着执行 `InitProcessPhase2()`，把自己注册进 `ProcArray`。

更奇怪的是，`PGPROC` 里明明已经有 `xid`、`xmin` 等字段了，PostgreSQL 又单独维护了一套：

```text
ProcGlobal->xids[]
ProcGlobal->subxidStates[]
ProcGlobal->statusFlags[]
```

同一份信息，看起来被保存了好几遍。

如果只盯着结构体，很容易把它们理解成几张不同的“进程表”。但顺着 backend 的生命周期继续往下看，会发现 PostgreSQL 真正要解决的问题，并不是“如何记录一个进程”。

它要解决的是：

> 一个普通的 OS 进程，怎么成为 PostgreSQL shared memory 世界里的一个参与者，让其他进程能够找到它、等待它、观察它发布的状态，最后又能安全地从这个世界里消失？

从这个角度再看 `PGPROC` 和 `ProcArray`，事情就清楚多了。

## PID 还不够

PID 很适合回答一个问题：

```text
这是哪个 OS 进程？
```

但数据库内部想知道的显然不止这些。

比如：

```text
谁正在等待一把锁？

我要唤醒哪个 backend？

哪个 backend 当前有 XID？

哪些事务还处于运行状态？

哪个 backend 还保留着比较老的事务视野？

这个 backend 退出以后，
其他进程从什么时候开始可以彻底忽略它？
```

这些问题有一个共同特点：**一个 backend 的状态，需要被另一个 backend 观察甚至操作。**

而 PostgreSQL 的 backend 是独立进程，当前进程里的栈、普通指针、backend-local 对象，拿到另一个进程里并没有什么意义。它需要一个所有 backend 都能认识的身份。

这个身份就是 `PGPROC`。

Postmaster 启动时，会提前在 shared memory 中准备好一批 `PGPROC` slot：

```text
ProcGlobal->allProcs[]

┌──────────┐
│ PGPROC 0 │
├──────────┤
│ PGPROC 1 │
├──────────┤
│ PGPROC 2 │  ← 某个 backend
├──────────┤
│   ...    │
└──────────┘
```

backend 启动以后，从对应的 freelist 中领取一个 slot。

当前 backend 用 `MyProc` 指向它，而 `MyProcNumber` 则提供一个可以跨进程使用的编号。其他 backend 如果保存了这个编号，就可以重新在 `ProcGlobal->allProcs[]` 中找到对应的 `PGPROC`。

这也是为什么 `PGPROC` 里的东西看起来有些杂：

```text
latch / semaphore

LWLock wait state
heavyweight lock state

wait event

xid / xmin / subxids

各种 group membership
```

这些东西并不属于某一个单独模块。

它们的共同点是：

> **都需要一个能够代表“这个 backend”的共享锚点。**

所以把 `PGPROC` 理解成“进程信息结构体”多少有些低估它。

我更愿意把它理解成：

> **backend 在 PostgreSQL shared memory 世界里的身份。**

这里还藏着一个挺有意思的 bootstrap 问题。

管理 PGPROC freelist 的锁是 spinlock（`ProcStructLock`），而不是更常见的 LWLock。

原因很简单：

```text
先拿到 PGPROC
    ↓
才能完整参与 LWLock 的等待和唤醒
```

如果“领取 PGPROC”这件事本身又依赖 LWLock，就形成了循环依赖。

所以进入共享世界的第一步，只能站在比 LWLock 更底层的同步设施上。

单独看这只是个实现细节，但放回整个启动顺序里，就很合理了。

## 有了 PGPROC，为什么还需要 ProcArray？

`PGPROC` 给了 backend 一个共享身份，但事情并没有到此结束。

关键在于：

**拥有一个共享身份，和向整个系统公开自己的事务状态，是两回事。**

可以粗略地理解成：

```text
PGPROC：
    我是谁？

ProcArray：
    哪些 backend 正在发布自己的事务状态？
```

一个 backend 内部有大量事务状态。

比如当前事务嵌套层级、command id、ResourceOwner，以及各种只对当前 backend 有意义的执行状态。

PostgreSQL 并没有因为其他 backend 偶尔需要了解事务状态，就把整个事务对象搬到 shared memory 中。

它只挑出别人必须知道的那部分：

```text
xid
xmin
SubXID 状态
状态标志位
...
```

然后发布出去。

所以这里有一条很明确的边界：

```text
完整的事务状态
        │
        └── backend-local

其他 backend 必须知道的事实
        │
        └── shared memory
```

我觉得这比单纯记住 `ProcArrayAdd()` 做了什么更重要。

多进程程序里，共享得越多，并不意味着设计越简单。

恰恰相反，共享状态意味着同步、内存可见性、生命周期和异常退出都要变成全局问题。

因此 PostgreSQL 没有试图共享“整个事务”，而是只发布并发协议真正需要的事实。

`ProcArray` 就站在这个边界上。

一个 backend 加入 `ProcArray`，并不意味着它现在一定有 XID。

事务开起来以后，完全可能暂时还没有真正的 XID。只有事务确实需要时，才通过 `GetNewTransactionId()` 分配 XID，并把它发布到共享状态里。

所以：

```text
进入 ProcArray
≠
已经有 XID
```

更准确地说，进入 ProcArray 意味着：

> **从现在开始，如果我产生了会影响其他 backend 判断的事务状态，我会按照这里的规则发布和撤销它。**

这样理解以后，ProcArray 就不像是一张“连接列表”了。

它更像是一组正在参与全局事务协议的成员。

## 为什么同一个 XID 还要再存一遍？

不过 PostgreSQL 又做了一件看起来很浪费的事情。

`PGPROC` 里已经有事务相关字段了，为什么还要维护：

```text
ProcGlobal->xids[]
ProcGlobal->subxidStates[]
ProcGlobal->statusFlags[]
```

原因不是语义不同，而是访问方式不同。

假设我要回答：

> backend 42 现在在等什么？

这时候最自然的方式是：

```text
ProcNumber
    ↓
PGPROC
    ↓
读取 backend 42 的状态
```

这是典型的**按对象访问**。

但另一些操作关心的是：

> 所有 backend 现在分别是什么状态？

这就变成了：

```text
backend 1
backend 2
backend 3
...
backend N
```

这是典型的**批量扫描**。

如果每次都在体积不小的 `PGPROC` 之间跳来跳去，只为了读取其中几个事务字段，CPU cache 的利用并不好。

于是 PostgreSQL 又维护了一套适合扫描的 dense arrays：

```text
xids:
[xid][xid][xid][xid][xid]...

subxidStates:
[...][...][...][...][...]

statusFlags:
[...][...][...][...][...]
```

而且这套 dense arrays 并不是新发明，可以说是 PostgreSQL 坚持了很久的老设计。

严格说，这个“惊讶”只对 PG 14 之后的版本成立。在那之前，xid、xmin 这些字段住在另一个结构体 `PGXACT` 里：`ProcGlobal->allPgXact[]` 同样是一组按 `pgxactoff` 索引的 dense arrays，PGPROC 自己则主要负责锁、等待和 latch 这些并发现场。

PG 14 干脆把 `PGXACT` 拆散成 `xids[]`、`subxidStates[]`、`statusFlags[]` 三个平行数组——“运行事务集”仍然是一份紧凑、适合扫描的布局，只是从“结构体数组”变成了“数组的结构体”。

所以“运行事务集值得一份独立的紧凑布局”这个决定，在 PostgreSQL 里已经有二十多年历史了。PGPROC 负责身份和并发现场，事务状态另起炉灶，这个分工不是最近才想出来的。

这也带来了两个很容易混淆的编号：

```text
MyProcNumber
pgxactoff
```

刚开始看到它们时，我下意识觉得都是“当前 backend 的下标”。

其实不是。

`MyProcNumber` 属于身份。

只要 backend 还占着这个 `PGPROC` slot，它就代表这个 backend 在 `allProcs[]` 中的位置。

而 `pgxactoff` 只是当前 backend 在那几组 dense arrays 里的位置。

ProcArray 成员发生变化以后，为了保持数组紧凑，会发生 `memmove()`，后面的 `pgxactoff` 也会随之变化。

所以可以这么区分：

```text
MyProcNumber：

    “我是谁？”


pgxactoff：

    “为了方便这次批量扫描，
     我现在排在哪里？”
```

看起来只是两个下标，背后却是完全不同的设计目标。

这也是这部分代码里我觉得挺有意思的地方：

> **同一份逻辑状态，不一定适合只有一种物理布局。**

按 backend 定位和扫描所有 backend，本来就是两种不同的工作负载。

PostgreSQL 并没有强迫 `PGPROC` 同时把两件事情都做好。

## 发布出去以后，真的有人会看吗？

既然花了这么多功夫发布状态，当然得有人消费。

一个最典型的例子就是 snapshot。

一个 backend 想建立自己的事务视图，需要知道在某个时刻：

```text
哪些事务还处于运行状态？
```

这个答案显然不可能只从自己的 backend-local memory 中得到。

其他事务都运行在别的进程里。

于是 `GetSnapshotData()` 会去扫描这些已经发布出来的共享事务状态。

大致可以画成：

```text
共享内存

不断变化的全局事务状态
             │
             │ 扫描
             ▼
       SnapshotData
             │
             ▼
当前 backend 使用的稳定视图
```

这里有个值得注意的转换。

ProcArray 中保存的是**全局的、不断变化的状态**。

而 snapshot 想得到的是：

> **在某个时刻，把这份不断变化的状态切下来，变成当前 backend 后面可以反复使用的一份局部视图。**

这至少说明：一个 backend 什么时候发布 XID、什么时候撤销 XID，并不是它自己的内部实现细节——同一时刻，另一个 backend 可能正在基于这些字段构造自己的判断。

类似地，一个 backend 发布的 `xmin` 等状态，也会被其他全局计算使用。

最典型的就是 vacuum 计算清理水位：扫一遍所有 backend 的 `xmin`，找出全局最老的事务视野，旧版本就清理到它为止。

所以一个 backend 如果把过时的 `xmin` 留在共享状态里，它拖住的不是自己，而是整个实例的清理水位——表里的旧版本清不掉，越积越多，就是我们熟悉的“表膨胀”。这时候监控里看到的往往是“vacuum 一直在跑，表却越来越大”，追到根上，其实是某个 backend 的 `xmin` 没有及时撤销。

重要的是：

**这些字段一旦进入 shared memory，就变成了其他 backend 会真正依赖的事实。**

那接下来的问题自然就来了：

进入这个世界很容易。

退出呢？

## 事务结束了，Backend 并没有消失

一个 backend 进入“共享世界”的过程，大概可以画成：

```text
OS 进程
    │
    ▼
InitProcess()
    │
    ▼
PGPROC
    │
    ▼
InitProcessPhase2()
    │
    ▼
ProcArray
```

那退出的时候，反过来执行一遍就行了吗？

并没有这么简单。

首先得区分三件事情：

```text
事务结束

backend 从 ProcArray 消失

PGPROC slot 被释放
```

它们是不同的生命周期。

最明显的例子就是长连接。

```text
backend / PGPROC 生命周期
|----------------------------------------------|

      事务 A              事务 B
      |-----------|        |-----------|
```

事务 A commit 以后，这个 backend 还会继续执行事务 B。

所以事务结束时当然不能把 `PGPROC` 给释放掉。

真正需要撤销的是当前事务发布出去的状态。

比如：

```text
xid
xmin
SubXID 状态
相关标志位
```

这些状态失效以后，得让其他 backend 不再把它们当作当前事实。

但 `PGPROC` 本身仍然属于这个 backend。

直到整个 backend 真正退出，才进入另一层清理：

```text
backend 退出
    │
    ▼
从 ProcArray 中移除
    │
    ▼
清理共享等待 / 进程状态
    │
    ▼
ProcKill()
    │
    ▼
PGPROC slot 回到 freelist
```

这几个阶段不能随便交换。

因为其他 backend 可能还拿这些共享状态做判断。

例如一个已经结束的事务，如果 XID 没有及时从共享的运行事务集里清掉，别人就可能继续把它当成运行中的事务。

如果一个已经不再需要的 `xmin` 留在那里，别人仍然会认为这个 backend 依赖更老的事务历史。

如果 lock wait state 没清理干净，影响的又是另一个完全不同的子系统。

更麻烦的是，`PGPROC` slot 最终还会被复用。

今天：

```text
PGPROC[42] → backend A
```

过一段时间可能就是：

```text
PGPROC[42] → backend B
```

因此释放一个 PGPROC，并不只是“把内存放回池子”。

它实际上意味着：

> **从这一刻开始，shared memory 中不能再有任何东西把这个 slot 当成原来的 backend。**

否则 backend B 接过来的，就不再是一个干净的身份。

所以看下来，我觉得 PostgreSQL 的清理有个很重要的特点：

> **清理的顺序，本身就是正确性的一部分。**

在 backend-local 世界里，一个对象用完以后 `free()`，很多时候生命周期就结束了。

但共享状态不一样。

只要还有其他进程可能观察你，退出就不是简单的资源释放，而是逐层撤销之前向整个系统做出的承诺。

先告诉别人：

```text
这个事务已经不再运行。
```

然后：

```text
这些事务状态已经不能再被依赖。
```

再到：

```text
这个 backend 已经不属于 ProcArray。
```

最后才是：

```text
这个 PGPROC 已经不再代表原来的进程，
slot 可以重新使用。
```

## 再看“共享世界”

这样回头看最开始的问题：

> 已经有 PID 了，为什么 PostgreSQL 还需要 `PGPROC`？

因为 PID 只能告诉 PostgreSQL：

```text
有这么一个 OS 进程。
```

但数据库真正需要的是：

```text
其他 backend 能找到我，锁和等待机制能引用我；

我能发布事务状态，别人可以扫描；

事务结束、进程退出时，我能逐层撤销；

最后这个身份还可以安全地交给下一个 backend。
```

所以一个 backend 真正进入 PostgreSQL 的“共享世界”，并不是从 fork 出来的那一刻开始。它还需要先拿到 `PGPROC` 这个身份，再把自己注册进 `ProcArray`，才算真正成为共享状态里的参与者。

而退出的过程，则是在一点点撤销自己曾经发布出去的状态和身份。

从这个角度看，`PGPROC`、`ProcArray`，甚至那些看起来有些重复的 dense arrays，都在解决同一个问题的不同侧面：

> **一个生命周期不断变化的进程，如何成为共享状态中的稳定参与者。**

开头那两个问题现在都能对上了：`xmin` 凭什么拖住全库的清理？因为它发布进了共享世界，而 vacuum 一直拿这份发布当事实。卡住的 backend 在等什么？它把“我在等锁”的事实挂在共享的锁结构里，锁释放的那一刻，唤醒就顺着这份记录发生。

多进程数据库里，难的从来不只是“大家怎么共享一块内存”。

真正麻烦的是：

**一旦别人开始依赖你发布的状态，你该如何存在，又该如何消失。**
