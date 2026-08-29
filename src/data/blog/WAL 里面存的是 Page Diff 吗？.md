---
author: Neil Chen
pubDatetime: 2026-08-29T00:00:00+08:00
title: WAL 里面存的是 Page Diff 吗？
description: 一个 Page 在 Shared Buffers 里被修改以后，PostgreSQL 到底往 WAL 里留下了什么？从 Heap Insert 一路看到 B-tree Split、FPI 和 rmgr。
tags:
  - postgresql
  - internals
---

# WAL 里面存的是 Page Diff 吗？

前面看 Shared Buffers 的时候，最后留下过这样一条链路：

```text
修改 Page
    ↓
MarkBufferDirty()
    ↓
生成 WAL
    ↓
PageSetLSN()
    ↓
以后再找机会把 Page 写回磁盘
```

当时为了不把话题扯得太远，WAL 基本被我压成了几个字：把这次修改记录下来。

继续往下读，马上就会碰到一个很具体的问题：

**到底怎么记录？**

比如 Shared Buffers 里原本有一个 8KB Page，执行一次 INSERT 后，多了一个 Line Pointer 和一条 Tuple。

```text
修改前                                  修改后

┌────────────────────┐             ┌────────────────────┐
│ Page Header        │             │ Page Header        │
├────────────────────┤             ├────────────────────┤
│ Line Pointer 1     │             │ Line Pointer 1     │
│ Line Pointer 2     │             │ Line Pointer 2     │
│                    │             │ Line Pointer 3  ← new
│                    │             │                    │
│                    │      ?      │                    │
│                    │ ─────────→  │ Tuple C       ← new
│ Tuple B            │             │ Tuple B            │
│ Tuple A            │             │ Tuple A            │
└────────────────────┘             └────────────────────┘

                 WAL 里是不是就存中间这个 Diff？
```

这是我最开始觉得很顺手的一种理解。

数据库本来就知道 Page 修改前后长什么样。那就比较两块内存，把变化的字节找出来写进 WAL；崩溃恢复时，再把这份 Diff 应用到旧 Page 上。

至少从接口上看，这甚至挺优雅：上层 Access Method 只管改 Page，WAL 层统一负责找差异。

但顺着 PostgreSQL 的实现看下去，并没有这样一个通用的 Page Diff 过程。

先看一次最普通的 Heap Insert。

## 一个 INSERT 到底留下了什么

Heap 往 Page 里插入 Tuple 时，WAL 相关代码大致长这样：

```c
XLogBeginInsert();
XLogRegisterData(&xlrec, SizeOfHeapInsert);
XLogRegisterBuffer(0, buffer, REGBUF_STANDARD);
XLogRegisterBufData(0, &xlhdr, SizeOfHeapHeader);
XLogRegisterBufData(0, tuple_data, tuple_len);
recptr = XLogInsert(RM_HEAP_ID, XLOG_HEAP_INSERT);
PageSetLSN(page, recptr);
```

这里没有 `CompareOldAndNewPage()`，也没有 `GeneratePageDiff()` 之类的环节。

Heap 是自己主动告诉 WAL 层的：

* 这是一次 Heap Insert；
* 我改的是哪个 Page；
* 这次 Insert 有哪些参数；
* 以后重建这条 Tuple，需要留下哪些数据。

真正修改 Page 的模块，本来就知道自己做了什么。

Heap 知道自己插入了一条 Tuple，B-tree 知道自己刚刚做了一次 Split。它们没必要等 WAL 层重新比较两张 Page，再猜一次刚才发生了什么。

于是问题从“哪些字节变了”，慢慢变成了：

> **如果以后要把这次修改重新做一遍，需要留下哪些东西？**

两个问题看起来很像，最后形成的 WAL Record 却很不一样。

## 先给这次修改找对 Page

恢复侧想重做 Heap Insert，第一件事不是看 Tuple。

它首先得知道：这条 Tuple 应该放在哪一页？

所以有：

```c
XLogRegisterBuffer(0, buffer, ...);
```

这个调用不会立刻把整个 Buffer 塞进 WAL。

它主要是在当前 WAL Record 中登记一个 Block Reference，其中最终会描述 tablespace、database、relation、fork 和 block number，也就是把目标 Page 找出来需要的信息。

比如：

```text
block 0
   │
   └── relation A
       main fork
       block 42
```

这里的 `0` 很容易和真正的 Block Number 混起来。

实际上，它只是**这条 WAL Record 内部给 Page 编的号**，真正的数据文件 Block Number 在这个例子里是 42。

Heap Insert 自己约定：

```text
block 0 = 要插入 Tuple 的 Heap Page
```

这样恢复侧读到 Record 时，就能通过 block 0 找到对应 Page。

到这里解决的只是“改谁”。

接下来还得知道“怎么改”。

## 这一堆字节，由谁来解释

WAL 里的 Payload 本身没有什么通用的恢复语义。

同样一段字节，Heap 可能把它解释成 Tuple Header、Tuple Data、Offset 和 Flags；B-tree 可能把它解释成 Index Tuple、High Key、Posting Offset 或 Split 信息。GIN、GiST 又有自己的格式。

所以 WAL Record 的固定头部里还有两个非常关键的字段：

`xl_rmid` 决定这条 Record 交给哪个 Resource Manager，`xl_info` 再标识这个 rmgr 内具体是哪一种操作。

比如一条 Heap Insert：

```text
xl_rmid = RM_HEAP_ID
xl_info = XLOG_HEAP_INSERT
```

恢复侧读到以后，大致会经过：

```text
WAL Record
    ↓
RM_HEAP_ID
    ↓
heap_redo()
    ↓
XLOG_HEAP_INSERT
    ↓
heap_xlog_insert()
```

到了 `heap_xlog_insert()`，Record 里的那些 Payload 才真正获得 Heap 的含义。

这也形成了 WAL 里一条很清楚的边界：

```text
                  WAL 通用层

        Record framing / CRC / decode
              Block References
                 Page Image
                    │
                    ▼
            ─────────────────
                    │
                    ▼
               各个 rmgr

        Heap / B-tree / GiST / GIN
          自己解释 Payload
          自己知道怎么改 Page
```

WAL 通用层只需要知道一条 Record 涉及哪些 Block、每个 Block 指向哪里、是否携带 Page Image、Payload 有多长，以及 Record 本身是否合法。

至于 Heap Tuple 怎么拼、B-tree High Key 怎么调整、Sibling Link 应该指向谁，都属于对应 rmgr 的语义。

这样 PostgreSQL 才能让 Heap、B-tree、GIN、GiST 共用一套 WAL Record 框架，又不需要让 WAL 子系统理解所有存储结构。

## 一条 WAL Record 大概长什么样

把目前看到的东西放在一起，一条 WAL Record 可以先画成这样：

```text
                     一条 WAL Record

┌──────────────────────────────────────────────────────────┐
│ XLogRecord                                               │
│                                                          │
│  xl_rmid = RM_HEAP_ID                                    │
│  xl_info = XLOG_HEAP_INSERT                              │
├──────────────────────────────────────────────────────────┤
│ Block Reference 0                                        │
│                                                          │
│  relation / fork / block number                          │
│                                                          │
│  ┌──────────────────┐     ┌────────────────────────────┐ │
│  │ Full Page Image  │     │ Block Data                 │ │
│  │    optional      │     │ tuple / high key / ...     │ │
│  └──────────────────┘     └────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│ Main Data                                                │
│                                                          │
│  offset / flags / rmgr-specific parameters               │
└──────────────────────────────────────────────────────────┘
```

真正的物理格式当然比这张图细很多。

不过为了理解 WAL Record 怎么描述一次 Page 修改，先抓住三件事就够了：

* `rmgr / info`：这是什么操作；
* Block Reference：涉及哪些 Page；
* Main Data、Block Data、Page Image：Redo 需要哪些恢复材料。

接下来再看这些材料为什么需要分开。

## Main Data 和 Block Data 为什么要分开

Heap Insert 生成 WAL 时既调用：

```c
XLogRegisterData(...)
```

又调用：

```c
XLogRegisterBufData(...)
```

名字很像，区别可以从“这些信息属于谁”来看。

`XLogRegisterData()` 登记的是整条 Record 的 **Main Data**。

比如 Heap Insert 使用的 `xl_heap_insert`，里面会带这次 Insert 的 Offset 和一些 Flags。这些信息描述的是整个操作。

`XLogRegisterBufData(0, ...)` 登记的则是 **block 0 这个 Page 自己的 Payload**。Heap Insert 里主要就是以后重建 Tuple 所需的数据。

所以刚才那次 Heap Insert 可以展开成：

```text
Heap Insert
    │
    ├── RM_HEAP_ID / XLOG_HEAP_INSERT
    │
    ├── Main Data
    │      └── offset / flags
    │
    └── Block 0
           ├── Page identity
           └── Tuple Payload
```

这样看，几个 `XLogRegister*()` 就没那么像名字差不多的拼数据接口了。

它们是在把一次修改拆成几个层次：操作本身的信息、参与这次操作的 Page，以及各个 Page 对应的恢复材料。

## 写 WAL 和 Redo，其实在维护同一份协议

Heap Insert 最有意思的地方，是把生成侧和恢复侧放到一起看。

```text
生成侧                                      恢复侧

heap_insert()                            heap_xlog_insert()
     │                                          ▲
     │                                          │
     ├── xl_heap_insert ─── Main Data ──────────┤
     │                                          │
     ├── Heap Page ─────── Block 0 Tag ─────────┤
     │                                          │
     └── Tuple ─────────── Block 0 Data ─────────┘
                         │
                         ▼
                    WAL Record
```

左边决定以后恢复时要留下什么，右边负责拿到这些东西以后怎么重新做。

比如生成侧只记录 Tuple Header 中真正需要的几个字段，再加 Tuple Data。

Redo 侧拿回来以后重新拼出 Heap Tuple，再调用 `PageAddItem()` 放回 Page。

因此 WAL Record 不需要同时保存修改前的 Page 和修改后的 Page。

它只要留下**足以重新执行这次状态变化的信息**。

这里已经能看出它和通用 Page Diff 的区别了。

## UPDATE 开始有一点 Diff 的味道

INSERT 比较简单。

UPDATE 就有意思多了。

PostgreSQL 的 Heap UPDATE 通常会生成新的 Tuple 版本。如果新旧 Tuple 在同一页，Record 可以只涉及一个 Page；如果跨页，则可能约定：

```text
block 0 = New Page
block 1 = Old Page
```

同一条 WAL Record 已经开始描述多个 Page 的协作修改。

更有意思的是，在合适的情况下，Heap UPDATE 还真的会自己做一点类似 Diff 的优化。

比如：

```text
Old Tuple: AAAAA BBBBB CCCCC
New Tuple: AAAAA XXXXX CCCCC
```

前缀 `AAAAA` 没变，后缀 `CCCCC` 也没变，那么 WAL 里可以只留下中间的 `XXXXX`，恢复侧再从旧 Tuple 把前后缀拼回来。

这确实很像开头想象的 Diff。

区别在于，这个 Diff 是 **Heap 自己设计的**。

WAL 通用层不知道 `AAAAA` 为什么可以不存、`CCCCC` 从哪里重新拿，也不知道什么时候这种优化是安全的。

Heap 的 WAL 生成逻辑知道，Heap 的 Redo 逻辑也知道。

它们之间共同维护这份约定。

所以 PostgreSQL WAL 里当然大量存在 Delta。只是没有一套 `UniversalPageDiff()` 自动分析所有 Page。

每个 rmgr 都可以根据自己的数据结构，决定什么才是恢复这次修改所需要的信息。

## 到 B-tree Split，Page Diff 的模型更难用了

Heap 修改大部分时候还围绕 Tuple 展开。

换成 B-tree Split，情况就复杂多了。

一个 Leaf Page 满了以后，需要拆成 Left Page 和 New Right Page，同时还可能修改原来的 Right Sibling，Internal Split 时还会涉及 Child Page。

于是 B-tree 可以给这些 Page 分配自己的 Block ID：

| WAL Record    | block 0      | block 1        | block 2        | block 3     |
| ------------- | ------------ | -------------- | -------------- | ----------- |
| Heap Insert   | 目标 Heap Page | —              | —              | —           |
| Heap Update   | New Page     | Old Page（跨页时）  | —              | —           |
| B-tree Insert | Index Page   | Child（部分情况）    | Metapage（部分情况） | —           |
| B-tree Split  | Left Page    | New Right Page | Right Sibling  | Child（部分情况） |

这张表里最值得注意的反而是 `block 0`。

它没有一种全局固定含义。

Heap 可以说 block 0 是 New Page，B-tree 可以说 block 0 是 Split 后的 Left Page。

所以 Block ID 更像是：

> **rmgr 给参与这次操作的 Page 分配的角色编号。**

WAL 通用层只负责保存这些 Page Reference。

至于为什么 block 2 要修改 Sibling Link，或者为什么 block 3 需要清理某个 B-tree 状态，还是 `btree_redo()` 自己理解。

到这里，一条 B-tree WAL Record 描述的已经更像**一次涉及多个 Page 的结构修改**，而不只是某一张 Page 上哪些字节发生了变化。

## 新 Right Page 连旧内容都不需要

B-tree Split 还有一个挺有意思的细节。

`block 1` 是新建的 Right Page。

既然这个 Page 是新建的，恢复侧没有必要先读一份旧内容，再在上面套 Delta。

旧内容本来就没有意义。

这种情况可以使用：

```text
REGBUF_WILL_INIT
```

它告诉恢复侧：这个 Page 可以重新初始化。

Redo 可以拿一个 Page，执行 `PageInit()`，然后根据 WAL Payload 从头构造出 Right Page。

这时候已经不存在“Old Page + Diff”这回事了。

更接近：

> 空 Page + 恢复材料 → 新 Page

只要 rmgr 知道自己留下的信息足够重新建立整个 Page，就没必要依赖旧内容。

不过还有一种更麻烦的情况。

旧 Page 存在，但恢复侧不敢相信它。

## Page 写到一半崩了怎么办

普通 Delta Redo 有个不太显眼的前提：

> 它操作的旧 Page 至少得是一份结构上正常的 Page。

比如 Heap Redo 想往 Page 里补一条 Tuple，它会使用现有 Page Header、Line Pointer 和剩余空间。

但一个 8KB Page 写到磁盘时，并不能简单假设整页写入天然是原子的。

如果写到一半系统崩了，就可能留下：

```text
正常 Page 写入

Memory                              Disk

┌───────────┐                   ┌───────────┐
│ New       │ ───────────────→  │ New       │
│ Page      │                   │ Page      │
└───────────┘                   └───────────┘


写到一半 Crash

Memory                              Disk

┌───────────┐                   ┌───────────┐
│ New       │                   │ NEW       │
│ Page      │ ────── X ─────→   ├───────────┤
│           │                   │ OLD       │
└───────────┘                   └───────────┘
                                  torn page
```

这时候磁盘上的 Page 既不是修改前版本，也不是修改后版本。

甚至 Page Header、Line Pointer 和 Tuple Data 之间都可能已经互相对不上。

拿这样的 Page 再应用一份小 Delta，就不一定还有意义了。

PostgreSQL 为此还有 Full Page Image，也就是 FPI。

某些 WAL Record 会直接带上一份足以恢复完整 Page 的镜像。恢复时直接使用这份镜像，不再相信数据文件里那张可能已经 torn 的 Page。

到这里，可以把我们看到的几种情况放到一起：

| 方式          | 恢复的起点               | WAL 主要提供什么         |
| ----------- | ------------------- | ------------------ |
| 普通 Delta    | 合法旧 Page            | rmgr-specific 修改信息 |
| `REGBUF_WILL_INIT` | 空 Page              | 从零构造 Page 所需的信息    |
| FPI         | WAL 中的完整 Page Image | 一个可信的 Page 基底      |

我觉得从这里开始，PostgreSQL WAL 的思路就比较清楚了。

它允许不同的修改选择不同的恢复材料。

旧 Page 可以继续使用，那就记录更小的 Delta。

Page 本来就是新的，那就直接从零构造。

旧 Page 可能已经不可信，那就准备一份 Full Page Image。

## FPI 有了，Delta 就一定没用了么

如果某个 Block 已经带了一份完整 Page Image，那么同一个 Block 原本登记的普通 Block Data，很多时候确实没必要继续写进 WAL。

因为对于 Crash Recovery 来说，FPI 已经足够得到一个正确 Page。

再记录一份“这个 Tuple 应该怎么插”，可能只是重复信息。

所以正常情况下，如果 FPI 已经足够恢复这个 Block，对应的 Block Data 可以被省掉。

不过 PostgreSQL 还有：

```text
REGBUF_KEEP_DATA
```

它可以要求即使有 FPI，这份 Block Data 也继续保留。

Heap Insert 在一些需要 Logical Logging 的场景下就会这么做。

原因也很直接。

Crash Recovery 关心的是：

> 给我一个正确的 Page。

Logical Decoding 关心的却可能是：

> 刚才 INSERT 的那条 Tuple 到底是什么？

FPI 里当然也包含那条 Tuple，但它不是 Logical Decoding 最方便消费的变化描述。

所以一条 Record 里可以同时存在 Full Page Image 和 Tuple Payload。

它们服务的是不同消费者。

这也提醒了一件事：WAL 最初围绕 Crash Recovery 设计，但现在 Replication、Logical Decoding 等能力也都建立在这条日志上。

## 这些东西什么时候才真正拼成 Record

前面一直在调用：

```c
XLogRegisterBuffer(...)
XLogRegisterData(...)
XLogRegisterBufData(...)
```

有件事值得单独强调。

调用这些函数的时候，Record 其实还没有正式写进 WAL Byte Stream。

这些 API 更像是在 Backend 私有工作区里收集材料：

* 这条 Record 涉及哪些 Page；
* Main Data 有什么；
* 每个 Block 分别有哪些 Payload。

真正负责把这些东西组织起来的是：

```text
XLogRecordAssemble()
```

它会遍历已经登记的 Block，组织 Block Header、Block Data 和 Main Data，同时决定当前 Page 是否需要 FPI、某些 Block Data 是否还要保留，以及 Page Image 是否可以去掉 Hole 或进行压缩。

特别是 FPI，并不是调用 `XLogRegisterBuffer()` 时就立刻把整个 Page 复制进去。

是否需要 Image，要到组装 Record 时再结合 Page LSN、当前 Redo Pointer 和 Flags 判断。

默认 Full Page Write 机制下，Checkpoint 推进以后，一个 Page 第一次发生 WAL-logged 修改时通常需要留下 FPI；后续修改一般又可以继续使用更小的 Delta。

```text
Checkpoint
    ↓
Page 在当前周期第一次 WAL-logged 修改
    ↓
留下一个可信的 Page Image
    ↓
后续修改继续使用更小的 Delta
```

这里继续往下已经会进入 Full Page Writes 和 Checkpoint 的话题，这篇先不展开。

目前只需要知道一件事：

**Page Image 也是 WAL Record 描述一次修改时可以选择的一种恢复材料。**

## 恢复侧正好沿着相反方向拆包

生成侧不断给 Record 准备材料。

恢复侧正好反过来：

```text
Access Method
     │
     ▼
XLogRegister*
     │
     ▼
XLogRecordAssemble()
     │
     ▼
┌──────────────┐
│  WAL Record  │
└──────┬───────┘
       │
       ▼
 DecodeXLogRecord()
       │
       ├── Block References
       ├── Block Data
       ├── Main Data
       └── Page Images
       │
       ▼
   xl_rmid / xl_info
       │
       ▼
      rmgr
       │
       ▼
  Redo Page 修改
```

WAL Reader 负责把通用格式重新拆出来，然后通过 `xl_rmid` 找到具体 rmgr，再由 `xl_info` 选择对应的 Redo Routine。

最后，rmgr 把 Record 里的材料重新变成一次真实的 Page 修改。

这也是为什么读 WAL 相关源码时，我觉得最好把生成侧和 Redo 侧一起看。

只看 `XLogRegisterBufData()`，很难知道这些字节为什么这样组织。

找到恢复侧对应的 `XLogRecGetBlockData()`，很多东西一下就能对起来。

一边负责装，一边负责拆。

中间的 WAL Record，就是双方共同维护的一份持久化约定。

## 再回头看 Page Diff

所以，WAL 里面存的是 Page Diff 吗？

如果这里的 Page Diff 指的是：

> 拿修改前后的两块 8KB Page 自动比较，然后把变化的字节统一写进 WAL。

PostgreSQL 基本不是这样生成 WAL 的。

真正理解数据结构的模块，会自己决定恢复这次修改需要留下什么。

Heap Insert 留下 Tuple、Offset 和 Flags。

Heap Update 发现新旧 Tuple 有相同 Prefix / Suffix，还可以把重复部分省掉。

B-tree Split 知道哪些 Page 参与了这次结构变化，也知道新 Right Page 可以从零构造。

旧 Page 可以继续作为基础时，用 rmgr-specific Delta。

Page 本来就是新的，可以 `REGBUF_WILL_INIT`。

旧 Page 可能已经 torn 时，还有 FPI。

于是一次 Page 修改进入 WAL 的过程，更像这样：

```text
                一次 Page 修改
                      │
                      ▼
              Access Method / rmgr
                      │
        如果现在机器突然没了，
        以后拿什么才能把它恢复？
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   做了什么？      改了谁？       怎么恢复？
       │              │              │
 xl_rmid/info     block refs     payload / FPI
       │              │              │
       └──────────────┼──────────────┘
                      ▼
                  WAL Record
                      │
                    Crash
                      │
                      ▼
                 WAL Reader
                      │
                      ▼
                    rmgr
                      │
                      ▼
              把 Page 修改做回来
```

所以我现在更愿意把一条 WAL Record 看成一份**恢复材料包**。

外面是一套通用格式，负责保存、校验、读取和定位；里面装什么，则交给真正理解这次修改的模块决定。

这样再回去看 XLogRegisterBuffer()、XLogRegisterData() 和 XLogRegisterBufData()，它们其实一直在回答同一个问题：

> **如果现在机器突然没了，恢复侧需要拿到哪些东西，才能把刚才这次 Page 修改重新做出来？**

一条 WAL Record，就是这个问题留下来的答案。