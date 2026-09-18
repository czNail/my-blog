---
author: Neil Chen
pubDatetime: 2026-09-19T00:00:00+08:00
title: Checkpoint、BgWriter、WAL Writer，PG 的三个后台写进程
description: Checkpointer、Background Writer 和 WAL Writer 都会在后台写盘，但它们守的是三个不同的边界：Recovery 从哪里开始、Buffer 能不能顺利复用、WAL 推进到了哪里。这三个边界之间，又一直在互相借力。
tags:
  - postgresql
  - internals
---

# Checkpoint、BgWriter、WAL Writer，PG 的三个后台写进程

Data Page 的 sync 责任最后会在这里收口，Crash Recovery 从哪里开始也和它直接相关。前面几篇为了讲 WAL、COMMIT 和 Data Page，已经几次碰到 Checkpoint，但一直没有真正展开。

这次专门讲它，顺便把后台另外两个写盘的角色也拉进来：

```text
Checkpointer
Background Writer
WAL Writer
```

三个进程都长期运行，也都会产生磁盘 I/O，但解决的并不是同一个问题。

先从 Checkpoint 说起。

## Checkpoint 到底完成了什么

把 Checkpoint 理解成"定期刷脏页"当然没问题。系统跑一段时间，Shared Buffers 里就会积累一批 Dirty Page，Checkpoint 确实会写出其中一部分。

不过把 Crash Recovery 放进来，这个模型就缺了一块。

假设 WAL 已经推进到 `0/9000`。数据库当然可以每次都从很早的位置开始恢复：

```text
0/1000 ----------------------------------> 0/9000
        crash 后每次都从这里 replay
```

这样也能用，只是 WAL 越长，要 replay 的历史就越长。Checkpoint 会周期性地把恢复起点往前推：

```text
old redo                 new redo      current WAL
   |                        |              |
0/1000 ------------------ 0/6000 ------- 0/9000
```

以后从 `0/6000` 开始 replay 就够了。

这句话带着一个条件：既然 `0/6000` 之前的 WAL 不打算再 replay，那么恢复所依赖的更早的数据状态，必须已经能从 Data File 里接上。

比如 `0/5000` 的 WAL 修改了 relation A 的 block 42。如果这个 Page 还没可靠落下来，redo point 就已经推到 `0/6000`：

```text
0/5000  修改 block 42，但还没落盘
0/6000  redo point 推到这里

CRASH   Recovery 从 0/6000 开始
        → 补不回 0/5000 的修改
```

所以 Checkpoint 建立的是这样一个边界：

```text
                 Redo Point
                     |
old WAL -------------+------------ new WAL
                     |
        磁盘上的 Data File 要能从
          这里接住后面的 Recovery
```

刷 Dirty Page，只是建立这个边界的一部分。上一篇停在 `write()` 和 `fsync()` 之间那道缝上，这一篇要看的，是这套持久化责任在三个后台进程之间怎么分。

## 一个在线 Checkpoint 有两个重要位置

Checkpoint 的起点和终点，隔着一大堆 I/O。

Checkpoint 要先固定这一轮新的 redo pointer，也就是未来 Recovery 的下界；随后再圈定并持久化这一轮需要负责的数据状态。而"这轮 Checkpoint 已经完成"这件事，要等脏页写回和文件同步结束以后才能宣布。

两个时刻对不上，所以 WAL 里会留下两条 Record。

Checkpoint 开始时，先插入一条 `XLOG_CHECKPOINT_REDO`。它的起始位置，就是这一轮新的 redo pointer。

之后 Checkpointer 才去处理本轮的数据状态：写脏页、同步文件、等待 I/O。

等这些工作做完，再插入并 Flush 一条：

```text
XLOG_CHECKPOINT_ONLINE
```

这就是平时说的那条 checkpoint record，里面带着一个 `CheckPoint` 结构。

所以一轮 online checkpoint 里有两个不同的 LSN：

```text
redo pointer       = XLOG_CHECKPOINT_REDO 的位置
checkpoint record  = XLOG_CHECKPOINT_ONLINE 的位置
```

checkpoint record 里的 `CheckPoint.redo`，指回前面那个 redo pointer。`pg_control` 最后保存的也是这两样东西：

```text
ControlFile->checkPoint          -> checkpoint record
ControlFile->checkPointCopy.redo -> redo pointer
```

Crash Recovery 启动时，先从 `pg_control` 找到 checkpoint record，再根据里面的 `redo` 找到 replay 起点。

于是一轮 online checkpoint 的顺序大致是：

```text
插入 XLOG_CHECKPOINT_REDO，确定 Redo Point
        |
        v
完成本轮的数据持久化
        |
        v
写并 Flush XLOG_CHECKPOINT_ONLINE
        |
        v
更新并持久化 pg_control
```

这个顺序里有一点很重要：

> **新的恢复入口，只能在支撑它的数据状态准备好以后再发布。**

如果中途 Crash，比如脏页写了一半：

```text
XLOG_CHECKPOINT_REDO
        |
        v
write Page A
write Page B
        |
      CRASH
```

这一轮 Checkpoint 还没完成，`pg_control` 里也还是上一次成功的 Checkpoint。下次启动，用的仍然是上一个恢复入口。

## Checkpoint 怎么知道这一轮负责哪些 Page

在线 Checkpoint 还有一个问题：业务不会因为 Checkpoint 开始就停止修改 Buffer。

```text
Checkpointer                Backends

write Page A                dirty Page D
write Page B                dirty Page E
write Page C                dirty Page F
```

如果 Checkpoint 的结束条件是"Shared Buffers 里不再有 Dirty Page"，一个持续写入的数据库很可能永远结束不了。

`BufferSync()` 的做法是先扫一遍 Buffer Pool，把当前这一轮需要写回的 Dirty Permanent Buffer 标记成：

```text
BM_CHECKPOINT_NEEDED
```

之后写回时，追的就是这个标记。扫描之后新产生的 Dirty Page 没有标记，本轮不用管：

```text
扫描时：

  A  dirty + CHECKPOINT_NEEDED
  B  dirty + CHECKPOINT_NEEDED
  C  dirty + CHECKPOINT_NEEDED

扫描之后：

  D  dirty
  E  dirty
```

比如 block 42 在扫描时还是脏的，它就会属于 A、B、C 这一批。

D、E 这些后续变化发生在 redo pointer 之后。对于需要恢复的 WAL-logged 修改，相关 WAL 仍然位于新的恢复起点之后，因此 Checkpoint 不需要为了它们继续追着刷。

所以 Checkpoint 只需要处理一个有限集合，不必追逐扫描之后才产生的所有脏页。这里稳定的边界是：

> **Checkpoint 不需要追上扫描之后新产生的所有 Dirty Page，就能结束这一轮。**

当然，这不等于 D、E 和当前 Checkpoint 完全无关。比如一个已经进入本轮集合的 Page，Checkpoint 期间又被修改，后续写出完全可能顺便把更晚的状态也带下去。

文件同步层也是同一个思路。Data Page `write()` 之后留下的 `FileTag` 粒度 sync request，会被 Checkpointer 吸收到 `pendingOps` 里；`ProcessSyncRequests()` 再通过 sync cycle，把已经属于本轮的请求和同步过程中新到的请求分开。

Buffer 和 File 两层其实在解决同一件事：

```text
一个持续变化的系统
        |
        v
先圈定这一轮的责任
        |
        v
把这一轮做完
```

而不是要求整个数据库停下来配合。

## Checkpoint 里的 write 和 sync 是两段工作

上一篇已经走过这条链，这里只留一句：`write()` 只是把 Page 交给 kernel page cache，真正让它 durable 的是后面的文件同步。Checkpoint 日志里的 `write=...` 和 `sync=...`，本来就在描述两个不同阶段。

对 Permanent Buffer 来说，写 Page 之前还有一层 WAL-before-data：

```text
Page LSN
    |
    v
XLogFlush(page_lsn)
    |
    v
write Data Page
```

Checkpoint 负责的，就是把这批持久化责任收口：本轮要写的 Page 写出去，要同步的文件同步完，新的恢复边界才有资格发布。

这些脏页并不一定非要 Checkpointer 亲自写。但如果不提前做点准备，它们很可能一直堆到 Checkpoint 或者 Backend 真正需要 Slot 的时候才写，运行时的 I/O 就会比较被动。这时候才轮到 BgWriter。

## BgWriter：提前准备可以复用的 Clean Buffer

Backend 发生 Buffer Miss，需要新的 Buffer Slot 时，会通过 replacement strategy 找一个 victim。

找到 Clean Buffer，复用相对简单。如果找到的是 Dirty Buffer：

```text
Buffer Miss
    |
    v
find victim
    |
    v
dirty
    |
    v
FlushBuffer()
    |
    +--> 必要时 XLogFlush(page_lsn)
    |
    +--> write Data Page
    |
    v
复用 Buffer
```

一次 Buffer Miss 就临时多出一次 Data Page I/O。Checkpoint 最终可能也会处理这个 Page，但 Backend 此刻就要 Slot，等不了下一次 Checkpoint。

BgWriter 要减少的就是这种情况。

对 replacement 来说，一个值得提前处理的 Buffer 通常满足：

```text
refcount == 0
usage_count == 0
```

说明当前没人 pin，而且从 Clock Sweep 的视角看，已经没有剩余的 usage_count 热度。如果它同时还是 `BM_VALID` 和 `BM_DIRTY`，那就是很典型的"很可能被 replacement 选中，但真正复用之前还得先写出去"的 Buffer。

BgWriter 会参考 Clock Sweep 的推进情况和近期的 Buffer allocation 速度，沿着 replacement hand 往前找这类 Buffer，提前写掉：

```text
Clock Sweep 前进方向
        -------------------->

+------+-------+-------+-------+-------+
| hot  | dirty | dirty | clean | hot   |
+------+-------+-------+-------+-------+
             ^
             |
          BgWriter
      （提前写这一批）

dirty + reusable  ->  clean + reusable
```

比如 block 42，只要后面一段时间没人再碰，就会慢慢变成这样的候选 Buffer。等 Clock Sweep 真的扫到这里，直接复用，前台就少了一次 Dirty Page write。

所以 BgWriter 的目标不是把 Shared Buffers 尽量写干净。它更关心的是：Clock Sweep 接下来大概需要多少 clean reusable buffer？

## BgWriter 可以估错

BgWriter 看不到未来，只能根据过去的 replacement 消费速度去猜。`nextVictimBuffer`、`completePasses`、`numBufferAllocs` 这几个进度，被它拿来估 hand 走到哪了、最近分配了多少 Buffer。BgWriter 内部还会平滑近期的 allocation 速度和 reusable buffer 密度；`bgwriter_lru_multiplier` 用来放大预计的 Buffer 需求，`bgwriter_lru_maxpages` 则限制一轮最多写多少 Page。

工作负载突然变化时，没提前准备够 Clean Buffer 很正常。这时候：

```text
dirty victim
    |
    v
Backend 自己执行 FlushBuffer()
```

正确性不受影响，只是一次本来有机会在后台完成的写入，落到了前台路径上。

所以 BgWriter 更像一个提前备货的角色：

```text
Backend 持续消费 reusable buffer
              |
              v
       allocation feedback
              |
              v
          BgWriter
              |
              v
提前补充 clean reusable buffer
```

估得准，前台更平滑；估不准，Backend 自己兜底。

## BgWriter 和 Checkpointer 会写到同一个 Page

两者目标不同，但实际处理的 Buffer 会有交集。

block 42 就是个例子：Checkpoint 扫描时它还是脏的，于是带着两个标记：

```text
BM_DIRTY
BM_CHECKPOINT_NEEDED
```

Checkpointer 还没处理到它，BgWriter 先发现它已经适合 replacement，顺手把这一版写了出去。这一次 `write()` 同时帮了两个忙：BgWriter 拿到了一个更容易复用的 Buffer，Checkpoint 也少了一个待写对象。

I/O 完成时，Dirty 和 checkpoint-needed 会一起清掉。如果之后这个 Page 又被修改，它会重新变 Dirty，新的变化由后续 WAL 和下一次写回接着处理。

所以"工作由谁完成"和"责任由谁承担"可以分开。Checkpoint 并不要求本轮每个 Buffer 都由 Checkpointer 亲自 `write()`，Backend 或 BgWriter 提前完成的结果，它一样能用。

## WAL Writer：提前推进 WAL

WAL 这边也有后台推进者，而且这边有三个进度：

```text
Inserted  ->  Written  ->  Flushed
```

也就是：

```text
WAL inserted >= WAL written >= WAL flushed
```

Record 插入后，插入位置往前推；内容真正 write 到 WAL File 后，Written 推进；经过 `fsync`、`fdatasync` 或其他同步语义之后，Flushed 才推进。

对同步 COMMIT 来说，PostgreSQL 最终判断的是 Flush 位置。Inserted 和 Written 都还不是提交路径对客户端保证的 durability 边界。

同步提交最终等的就是：

```text
Flush LSN >= Commit LSN
```

如果 Backend 每次需要 `XLogFlush()` 时，前面的 WAL 都还堆在 WAL Buffer 里，那很多 WAL I/O 就会落到前台。WAL Writer 会周期性地调用：

```text
XLogBackgroundFlush()
```

尽量把 WAL 提前写出去。

不过这里要分清 Write 和 Flush。WAL Writer 通常只把完整的 WAL Page 写出去：

```text
0/1000 ---------------------------------------- 0/9000
                                               Inserted

0/1000 ------------------------- 0/7000
                               Written
```

如果没有完整的 WAL Page 需要处理，它还会检查 `asyncXactLSN`，避免异步提交长时间停在未填满的 WAL Page 中。至于这一轮是否同时推进 Flush，则由 `wal_writer_delay`、`wal_writer_flush_after` 等条件决定。

所以 WAL Writer 不是每醒一次就要 fsync 一次。它做的是：持续推进 WAL Write，并在需要的时候推进 Flush。

## WAL Writer 提前完成的工作，Backend 可以直接使用

假设一个事务的 `Commit LSN = 0/6500`。同步提交准备执行 `XLogFlush(0/6500)`，如果此时 Flush 位置已经到了 `0/7000`：

```text
              Commit LSN
                  |
                  v
0/0000 -------- 0/6500 -------- 0/7000
                                  ^
                                  |
                              Flush LSN
```

条件已经满足，这次提交不需要再做 WAL I/O。这份工作可能是 WAL Writer 提前完成的，也可能是别的 Backend 在 flush 更靠后的 LSN 时顺手带过去的。

反过来，如果当前只 Flush 到 `0/6000`，同步提交的要求不会因为有 WAL Writer 就改变，仍然要有人把 Flush 推过 `0/6500`——只是这个"有人"，常常就是 Backend 自己。

这和 BgWriter 有点像：

```text
BgWriter
    尽量提前完成可能落到前台的 Data Page write

WAL Writer
    尽量提前完成可能落到前台的 WAL write / flush
```

两者都没有取消前台路径，只是让前台少等一会儿。

## 异步提交让 WAL Writer 更忙

`synchronous_commit = off` 时，事务允许在自己的 Commit Record 还没 durable 时返回。Backend 不等了，这笔账就得有人接着。

PostgreSQL 会通过 `asyncXactLSN` 记录最新的异步事务 LSN。在没有完整 WAL Page 需要优先处理时，`XLogBackgroundFlush()` 会检查它，必要时把落在当前未完整 WAL Page 中的异步 Commit Record 也写出去。

所以异步提交选的是：

```text
COMMIT 更早返回
       |
       v
留下一个 Commit Record 尚未 durable 的窗口
       |
       v
由 WAL 后台推进机制收口
```

同步提交没有这个窗口。Flush LSN 覆盖自己的 Commit LSN 之前，它哪儿也不去。

## WAL Writer 也会影响 Data Page 写入

WAL Writer 处理的是 WAL，但它推进的结果会被 Data Page 路径直接消费。

Permanent Buffer 写出去之前必须满足 WAL-before-data：

```text
Page LSN
    |
    v
XLogFlush(page_lsn)
    |
    v
write Data Page
```

所以 Backend eviction、BgWriter、Checkpointer 只要需要写 Permanent Dirty Buffer，都可能撞上这个检查。block 42 的 Page LSN 是 `0/5000`，如果 WAL 已经提前 Flush 到它后面：

```text
Page LSN
   |
   v
0/5000 ----------------------- 0/7000
                                 ^
                                 |
                             Flush LSN
```

`XLogFlush(page_lsn)` 很快就能返回。

于是 WAL Writer 的结果不只服务 COMMIT：

```text
WAL Writer 推进的 Write / Flush
        |
        +--> 同步提交：COMMIT 不用自己等
        |
        +--> Data Page 写出：WAL-before-data 已经满足
```

WAL 和 Data Page 各有自己的后台节奏，但 WAL-before-data 又把两边绑在了一起。

## 再看三个后台写进程

三个进程都会产生写 I/O，但盯的是三件不同的事：

| 进程         | 主要对象                                    | 要回答的问题                                  | 顶不住的时候               |
| ------------ | ------------------------------------------- | --------------------------------------------- | -------------------------- |
| Checkpointer | checkpoint dirty set、pending sync requests | Recovery 从哪里开始？                         | 本轮 Checkpoint 无法发布   |
| BgWriter     | reusable dirty buffer                       | 下一次 Buffer Replacement 会不会卡在写脏页？  | Backend 自己写             |
| WAL Writer   | WAL stream                                  | 下一次需要 WAL 时，Write / Flush 推进到哪了？ | 需要 WAL 的 Backend 自己推 |

分开看是三套责任，合起来看又常常互相借力：

```text
BgWriter / Backend 提前写 Page
        |
        v
Checkpointer 少一次 write

WAL Writer / 其他 Backend 提前 Flush WAL
        |
        v
COMMIT 和 Data Page write 都直接受益
```

PostgreSQL 并没有把每一次 I/O 固定绑给某个后台进程。它真正在意的是几个条件有没有被满足：

```text
Buffer 要复用
    -> Dirty Victim 必须先处理

Permanent Data Page 要写
    -> 对应 WAL 必须先满足 WAL-before-data

Checkpoint 要完成
    -> 本轮持久化责任必须达到可发布状态

同步 COMMIT 要返回
    -> Flush LSN 必须覆盖 Commit LSN
```

哪个进程提前满足了条件，其他路径就可以直接用。

所以 Checkpointer、BgWriter 和 WAL Writer 看起来都在后台"写盘"，真正把它们区分开的，是 **Recovery、Buffer Replacement 和 WAL Progress 三套不同的责任边界**。
