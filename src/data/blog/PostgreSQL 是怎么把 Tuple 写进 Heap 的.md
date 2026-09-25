---
author: Neil Chen
pubDatetime: 2026-09-25T00:00:00+08:00
title: PostgreSQL 是怎么把 Tuple 写进 Heap 的
description: 顺着一次 Tuple 写入，看看 FSM、Visibility Map、Buffer Lock 和 WAL 是怎么在 Heap AM 里接到一起的。
tags:
  - postgresql
  - internals
---

# PostgreSQL 是怎么把 Tuple 写进 Heap 的

PostgreSQL 说的 Heap，和程序里那个 heap memory 没什么关系。

普通表默认走 Heap Table Access Method。数据文件被切成一个个固定大小的 Page，每个 Page 里躺着若干 Tuple Version。索引里拿着 TID，最后也是靠 `(block number, offset number)` 找到 Heap 里的位置。

先把物理模型摆出来：

```text
Heap Relation
|
+-- Page 0
|   +-- offset 1 -> Tuple Version
|   +-- offset 2 -> Tuple Version
|   +-- ...
|
+-- Page 1
|   +-- offset 1 -> Tuple Version
|   +-- ...
|
+-- ...
```

这篇关心的 Heap 写入主要有两类动作：放进去一个新的 Tuple Version，以及修改已有版本的状态。INSERT 只碰前一件；UPDATE 会同时碰两件，旧版本留在原地，新版本另找地方。

索引那边先不展开，等 HOT 和 UPDATE 需要它的时候再带出来。

## Tuple 先得找到一个 Page

`heap_insert()` 拿到 Tuple，第一件事是决定写哪个 Page。

从文件头一页页扫过去显然不行，表一大，光找空位就能把 INSERT 拖垮。一直往 relation 末尾追加也不行，前面被 UPDATE、DELETE、VACUUM 腾出来的空间就白费了。

PostgreSQL 为此单独维护了一份 Free Space Map，也就是 FSM。

FSM 是 relation 的一个独立 fork，记的是各个 Heap Page 大致还剩多少空间，给 INSERT 一个快速缩小范围的入口。它不记精确字节数，而是把空间压成 256 个 category——默认 8KB Page 下，一个 category 差不多 32 字节。

结构上，可以把它想成一棵"每个节点记住子树里最大剩余空间"的树。下面是个简化示例，括号里是内部节点，`#` 后面是 Heap Page 的 block number：

```text
              FSM
           +-------+
           |  180  |
           +---+---+
             /   \
         (180)   (120)
         /   \    /   \
      180    60 120    30
       |     |   |     |
       v     v   v     v
     #100  #101 #102  #103
```

现在需要一个 category 至少到 100 的 Page，上层节点就能帮忙跳过大片明显不够的地方。真实实现里，一个 FSM Page 内部先有一棵小树，多个 FSM Page 再拼成 relation 级的多层结构。看 INSERT 选页时不必把这些都拆开，记住它在干"按剩余空间快速找候选 Block"这件事就够了。

不过 FSM 也不是唯一的信息来源。

`RelationGetBufferForTuple()` 会先看看手边有没有更近的线索——当前 Backend 最近成功写过的 target block，或者 Bulk Insert 正在用的 Page。都没有，才去翻 FSM；FSM 也说没有，就去试 relation 尾页；最后才是扩表。

这几条路有先后，倒不是说前面几条带着什么语义，更多是在利用"刚才写过、大概率马上还会写"的局部性，少搜几遍，也少跟别人抢。

FSM 的内容允许滞后。

假设它记着 Page 42 还剩 500 字节，你查到这儿，另一个 Backend 完全可能抢先一步，往 Page 42 里塞了 400 字节。所以 `GetPageWithFreeSpace()` 返回一个 Block Number，不代表 INSERT 就能直接写。

接下来还要：

* 把这个 Buffer 读进来；
* 拿一把 exclusive content lock；
* 在锁里重新算一遍 `PageGetHeapFreeSpace()`。

只有这一步确认够用，Page 才算真被选中。要是已经放不下，就把实际的剩余空间写回 FSM，再换下一个候选。

最终还有持锁后的 Heap Page 状态兜底，所以 FSM 可以维护得比较松。Heap Page 每动一下，不需要顺手去更新一个全局、绝对精确的空间索引。FSM 猜错一次，代价无非是多 retry 一次；某个 Page 明明有空间却没被 FSM 发现，无非是这块地方晚一点被复用。

连"空间变多"的传播也可以慢半拍。底层 slot 更新之后，上层节点不一定立刻反映新的最大值，留给后面的 `FreeSpaceMapVacuum()` 慢慢往上带。

这种对局部性的利用，在 relation extension 时也能看到。

relation 要扩展的时候，PostgreSQL 有时一口气扩好几个 Page。这些新 Page 也不是统统登记进 FSM，然后让大家一起抢。如果当前 Backend 本来就在做 Bulk Insert，它大概率马上还要接着用刚扩出来的 Page，于是其中一部分会先攥在自己的 `BulkInsertState` 或 target block 里，暂时不拿出来当公共候选。这样能少一点"一批全空 Page 刚出现，几个 Backend 立刻挤到同一页"的场面。

挑 Page 从来不只是挑"最空的"那个，还要权衡：

* 最近用过的 Page；
* Bulk Insert 要不要连续；
* fillfactor；
* 扩表；
* extension lock 的争用；
* FSM 自己的搜索开销。

目标始终是那个：尽量把已有空间用起来，同时别为了找一个"最优 Page"花掉太多。

## 真正修改 Page 以前

`RelationGetBufferForTuple()` 返回的时候，目标 Heap Buffer 已经 pin 住，exclusive content lock 在手里，剩余空间也确认过了。

但还不能马上 `PageAddItem()`。

如果这个 Page 原本是 all-visible，INSERT 会把这个状态打破。

Heap Page 自己有一个 `PD_ALL_VISIBLE`，relation 旁边还有一份 Visibility Map。VM 为每个 Heap Page 记两个状态：all-visible 和 all-frozen。

它和 FSM 都算辅助结构，要求却差得远。

```text
FSM 记错:
  多 retry 一次，或空间晚点复用

VM 错误地 set:
  Index Only Scan 可能跳过
  本应执行的 visibility check
```

所以普通 INSERT 进到一个 all-visible 的 Page，得同时清掉两处：

* Heap Page 上的 `PD_ALL_VISIBLE`；
* VM 里对应的那个 bit。

麻烦的是，VM 自己也是 Page。pin 对应的 VM Page 有可能触发 I/O。

PostgreSQL 不想攥着 Heap Page 的 content lock 去等这次 I/O，于是把 VM 的 pin 尽量提前：

1. 先看一眼 Page 当前的状态（还没上锁）；
2. 觉得可能要清 VM，就先把 VM Page pin 住；
3. 再拿 Heap Page 的锁；
4. 锁住之后重新确认；
5. 如果这中间别人改了状态、手里的 VM pin 不够用，就放掉 Heap 锁，补上 VM pin，再回来重新上锁。

这里出现了一次 unlock / relock / recheck。原因不复杂：既不想在握着 Page 锁的时候做可能阻塞的 I/O，又不能指望锁外瞥到的状态一直不变。

后面 UPDATE 等并发事务的时候，还会见到同样的套路。

## Tuple 真正落进 Page

准备工作齐了，`heap_insert()` 走到：

```c
START_CRIT_SECTION();
```

这行代码可以看成 Heap 写入的一条分界线。

它前面的事——Tuple 大小检查、TOAST、选 Page、扩表、pin VM、可能触发的 I/O——都还允许普通地失败、等待或者重试。

进了 critical section，共享 Page 才开始变。INSERT 的核心其实没几行：

```c
START_CRIT_SECTION();

RelationPutHeapTuple(...);

if (PageIsAllVisible(page))
{
    PageClearAllVisible(page);
    visibilitymap_clear(...);
}

PageSetPrunable(...);
MarkBufferDirty(buffer);

recptr = XLogInsert(...);
PageSetLSN(page, recptr);

END_CRIT_SECTION();
```

`RelationPutHeapTuple()` 最后会调 `PageAddItem()`。Page 给这个 Tuple 分一个 offset number，把 Tuple bytes 放进 tuple storage，同时得到新的 TID：

```text
(block number, offset number)
```

这个 TID 会写进 `tuple->t_self`。普通 INSERT 里，Page 内 Tuple Header 的 `t_ctid` 也先指向自己。

走到这儿，Shared Buffer 里的 Page 已经变了。假如代码能随便抛一个普通 `ERROR` 再只回滚上层 SQL 状态，Buffer 里就会留下一个不好解释的中间态。

所以 critical section 里的错误处理严格得多。像 `RelationPutHeapTuple()` 这种函数，一旦开始碰共享 Page，就不能靠普通 ERROR 抽身，严重错误会升级成 `PANIC`，让实例通过 crash recovery 重新回到一致状态。

Critical section 并不会让这几次内存修改变成原子操作。它约束的是错误处理：共享 Page 一旦开始变化，就不能带着可能不完整的状态继续运行，必要时直接进入 crash recovery。

Page 改完，`heap_insert()` 会写一条 `XLOG_HEAP_INSERT`。

这条 WAL record 带着 redo 这个 INSERT 需要的东西：

* 插到哪个 offset；
* Tuple Header 里恢复用得上的部分；
* Tuple data；
* 有没有清掉 all-visible；
* 某些特殊的 INSERT flag。

`XLogInsert()` 返回这条 record 的 LSN，紧接着被设回 Heap Page：

```c
PageSetLSN(page, recptr);
```

到这里，就和前面 Buffer Manager、WAL、Checkpoint 那几篇接上了。

Heap Page 什么时候真正刷进数据文件，不归 `heap_insert()` 管。写这个 dirty Page 之前只要满足 WAL-before-data，崩溃之后就能靠 Page LSN 和 WAL 判断哪些变化还需要 redo。

critical section 和 WAL 管的是两件事：前者约束 Shared Buffer 里这次修改怎么执行，后者处理改完之后数据页和日志可能不同时间落盘的问题。

也正因为这样，Heap 写入代码才会把各种可能等待、可能报错的事情尽量挪到 critical section 前面。真正落 Page 的那段越集中，WAL 就越能把它完整描述出来。

写进去，并不代表这个 Tuple 的生命周期就走完了。

事务照样可能 Abort。PostgreSQL 不会在 Abort 路径上回头找到这个 Tuple，把它从 Page 上抠掉。它的 `xmin` 指向一个已经 Abort 的事务，后面的 visibility 判断自然不会把它当成有效版本。占着的那点空间，留给以后 pruning 或 VACUUM 处理。

一个版本什么时候不再对查询有效，和它占的物理空间什么时候重新可用，是两个不同的时间点。INSERT 只负责把新版本立起来，旧空间和无效版本怎么清，是另一套生命周期的事。

到了 UPDATE，这层关系会更明显。

## UPDATE 把一次写入扩展到两个版本

Heap 上的 UPDATE 会新建一个 Tuple Version。旧版本还待在原来的 TID 上，只是 Header 变了；新版本重新找个位置。

普通 UPDATE 大概是这样：

```text
old tuple
    xmax   = updater
    t_ctid = new TID

new tuple
    xmin   = updater
    t_ctid = self
```

旧 Page 还有地方，新版本就留在同一页。放不下，两个版本就分到不同 Page：

```text
Page A offset 3     Page B offset 9
+------------+      +------------+
| old tuple  |      | new tuple  |
| xmax =X100 |      | xmin =X100 |
| t_ctid=B,9 +----->| t_ctid=self |
+------------+      +------------+
```

一次 UPDATE 于是会同时牵动：

* old Heap Page；
* new Heap Page；
* 两边可能各自对应的 VM Page；
* 旧 Tuple 的 `xmax`、`cmax`、`t_ctid`；
* 新 Tuple 的 Header；
* 已经存在的 Tuple Lock 或 MultiXact；
* 最后那条描述本次 UPDATE 的 WAL record。

UPDATE 之前，`heap_update()` 要先确认目标 Tuple 现在还能不能改。

这一步比 SELECT 意义上的 visibility 复杂。旧 Tuple 上的 `xmax` 可能代表：

* 已经有 updater；
* 有 deleter；
* 只是一个行锁；
* MultiXact 里的一群 locker / updater；
* 一个已经 Abort 的旧状态。

所以 `heap_update()` 得把 infomask、事务状态和 MultiXact 凑到一起，才能解释清楚这个 Tuple。

碰上冲突，当前 Backend 可能要去等另一个事务。等的时候当然不能一直攥着 Heap Page 的 content lock——代码会先把当前 `xmax`、infomask 这些信息存下来，放掉 Page 锁，再去等事务或 MultiXact。

等回来，重新上锁，还得比一遍 Tuple Header 有没有变过。刚才放锁的工夫，别的 Backend 可能又动过这条 Tuple：`xmax` 换了，MultiXact 成员也换了。状态对不上，就从头再判断一次。

读这类代码有个很省事的习惯：只要看到"放锁去等"，就默认等回来以后，凡是基于旧共享状态做出的判断都得重新验证。

## 跨 Page UPDATE

还有个更直接的问题。

假设两个 Backend 同时干这两件事：

```text
Backend A: Page 10 -> Page 20
Backend B: Page 20 -> Page 10
```

如果大家都先锁 old Page，再去等 new Page：

```text
Backend A           Backend B

lock Page 10        lock Page 20
     |                   |
wait Page 20        wait Page 10
```

Buffer Lock 就死锁了。

所以 UPDATE 找 new Page 的时候，`RelationGetBufferForTuple()` 会把 old buffer 一起带上。到了 UPDATE 这条路，它干的不再只是"帮忙找个有空位的 Page"，还要负责两个 Page 一起参与时的锁顺序。

单看 FSM 或 page selection，有些接口会比预期复杂，原因也在这里：INSERT 只要求"找一个能写的 Page"；UPDATE 把已有 Page 带进来之后，选页自然也得把跨 Page 的并发约束接过去。

等前面的并发检查、选 Page、pin VM、Buffer Lock 都办妥，UPDATE 也进 critical section，在里面一口气做完一串互相关联的修改：

* 把 new Tuple 插进 new Page；
* 给 old Tuple 设 `xmax`；
* 设 `cmax` 或 Combo CID；
* 把 old Tuple 的 `t_ctid` 指向 new TID；
* 设需要的 HOT flag；
* 清掉 old / new Page 上已经失效的 all-visible；
* 把相关 Buffer 标脏；
* 写 `XLOG_HEAP_UPDATE` 或 `XLOG_HEAP_HOT_UPDATE`。

两个版本要是不在同一个 Page，同一条 WAL record 就同时描述两个 Buffer 的变化：

```text
       XLOG_HEAP_UPDATE
          LSN = L
         /       \
        v         v
    Old Page    New Page
    LSN = L     LSN = L

    xmax=X100   xmin=X100
    t_ctid=B,9  tuple data...
```

两个 Page 不必一起刷盘。崩溃之前完全可能是这样：old Page 已经写进数据文件，new Page 还躺在 Shared Buffer 里。redo 会分别处理 WAL record 注册的 old / new Buffer，并根据各自的 Page LSN 判断对应 Page 是否已经包含这次修改。

跨 Page UPDATE 不需要什么"两个数据页同时落盘"的机制。Buffer Manager 照样按自己的节奏刷 Page；WAL 把同一次 UPDATE 涉及的两个 Page 装进同一段恢复语义里，替它们解决落盘时间不一致的问题。

前面几篇里讲的 Page LSN、WAL-before-data，落到 DML 路径上大概就是这个样子。

## HOT 留在同一个 Page 内

如果新版本还放得进 old Page，而且这次修改没碰那些会挡住 HOT 的索引属性，UPDATE 就能走 HOT。

Heap 这边该做的照做：

* 建一个新 Tuple Version；
* 改 old Tuple 的 `xmax`；
* 把 old 的 `t_ctid` 指向新版本；
* 写 WAL；
* 处理 visibility 状态。

区别主要在索引维护上。普通 UPDATE 一般要给新版本建一条新的 Index Tuple；HOT 允许原来的 Index Entry 继续当这条版本链的入口，把新版本标成 heap-only tuple。

这也要求整条 HOT chain 待在一个 Heap Page 里。要是允许版本链跨 Page，Index Scan、pruning、Page Lock，还有旧 root TID 的生命周期，全都要跟着扩到跨页范围。PostgreSQL 把这条链锁在一个 Page 内，后面的 pruning 才能在局部就把大部分活干完。

HOT pruning 这篇先不展开。

## 写入结束以后，Page 上留下什么

一条 INSERT 结束时，新的 Tuple Version 有了自己的 TID。

一条 UPDATE 结束时，old version 和 new version 之间也有了关系。

Page 上还会留下不少要交给后续生命周期处理的状态：

* Abort 的 INSERT 丢下的 Tuple；
* UPDATE 之后已经变旧的版本；
* HOT chain 里慢慢失去可见性的版本；
* 还被 Index TID 指着的 line pointer；
* 得等 pruning 和 VACUUM 之后才能重新利用的空间。

这些活不会回头塞进本次 INSERT 或 UPDATE 里做。Heap 写入只负责把新版本建出来，再把它跟事务状态、Page 状态、WAL 状态接好。旧版本什么时候消失，Tuple bytes 和 line pointer 又分别什么时候能复用，是后面另一套回收过程。
