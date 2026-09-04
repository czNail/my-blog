---
author: Neil Chen
pubDatetime: 2026-09-05T00:00:00+08:00
title: COMMIT 返回之前，PostgreSQL 到底在等什么？
description: COMMIT 返回之前，PostgreSQL 要等 WAL 持久化到自己的 Commit LSN。可这条有序日志是一群并发 Backend 写出来的，这条线比想象中曲折。
tags:
  - postgresql
  - internals
---

# COMMIT 返回之前，PostgreSQL 到底在等什么？

上一篇看 WAL 的时候，主要在想一条 WAL Record 里到底留下些什么。

Heap Insert 留下 Tuple，B-tree Split 留下参与结构变化的几个 Page，需要的时候还能直接塞一份 Full Page Image。真正修改数据结构的模块，自己决定恢复时需要哪些材料。

轮到事务提交，问题就换了一副面孔。

WAL Record 已经有了，那它得先走到什么位置，PostgreSQL 才敢对客户端说出那句：

```text
COMMIT
```

答案本身不复杂。

写事务收尾时会再留下一条 Commit Record，拿到它的 End LSN。同步提交下，PostgreSQL 调：

```c
XLogFlush(XactLastRecEnd);
```

要求 WAL 至少持久化到这个位置。

WAL 本来就是一条有序日志，Commit Record 排在这笔事务前面那堆 WAL 之后，Flush 到 Commit LSN，前面的自然也都过去了。这块没什么好展开的。

真正值得多看两眼的，是接下来的场景：

**当很多 Backend 同时往 WAL 里写的时候，这条“有序日志”并没有表面上那么整齐。**

## WAL 的位置排好了，内容可能还没写完

如果只有一个 Backend，事情很好想：分一个位置，把 Record 拷进 WAL Buffer，继续往后。

但 PostgreSQL 显然不能让所有 Backend 排着队，一个写完 WAL，下一个才能开始——高并发下，多个 Backend 会同时做 WAL insertion。

这里有两个动作得分开看：

```text
给 WAL Record 确定位置

和

把 WAL Record 的内容真正拷进 WAL Buffer
```

它们不是同一个时间点。

PostgreSQL 分配 WAL 位置时，那个共享的插入位置只被短暂占用一下。大致可以理解成：

```text
Backend A：我要 30 bytes
Backend B：我要 30 bytes
Backend C：我要 30 bytes

                ↓

WAL 地址

100 ........ 130 ........ 160 ........ 190
 │             │             │
 A             B             C
```

每个 Backend 很快拿到自己独占的区间，然后就可以放开那个全局位置锁，各自去拷自己的 Record。位置分配严格有序，填 WAL Buffer 却可以并发。

这一拆，马上就会出现这种状态：

```text
        Backend A        Backend B        Backend C

100 ───────── 130 ───────────── 160 ───────────── 190

██████??????   ████████████████   ████████████████
      ▲
      │
A 还没写完整
```

B、C 已经把自己的 Record 拷完了，A 反而还卡在前面。

Record 大小不同、进程调度不同，中间还可能碰上 WAL Buffer 初始化之类的事情，这都很正常。

于是：

> WAL 位置已经分到 190，不代表 190 以前的内容已经全部可以写盘。

磁盘上的 WAL 最终必须是一段连续、完整、能顺序解析的日志。总不能写成：

```text
Record A 前半截
一块不知道是什么的洞
Record B
Record C
```

然后让 Crash Recovery 自己猜。

所以真正 Flush 之前，PostgreSQL 还得知道一件事：

**目标 LSN 前面，还有没有 Backend 正占着一段没写完的 WAL。**

### 这个“洞”怎么找？

PostgreSQL 当然不会每次 Flush 都跑去 WAL Buffer 里从头扫描，看哪条 Record 只有半截。

Backend 真正拷 WAL Record 时，会持有一把 WAL insertion lock。

这把锁除了参与 insertion 的并发控制，还带着一个很重要的进度信息：

```text
insertingAt
```

它告诉其他人，这个 inserter 当前还可能影响到 WAL 的什么位置。

所以 Flush 端判断的不是：

```text
这块内存看起来写完了吗？
```

而是：

```text
目标 LSN 前面，
还有没有正在进行的 WAL insertion？
```

对应的入口就是：

```c
WaitXLogInsertionsToFinish(...)
```

如果某个 inserter 仍然挡在目标位置前面，就等它。

如果一个 inserter 已经明确表示目标 LSN 之前的内容都拷完了，即使它还在处理更靠后的 WAL，Flush 也不用等它全部结束。

于是前面图里的那个“洞”，不是靠检查 WAL 字节找出来的，而是正在写它的 Backend 通过 insertion lock 和进度位置声明出来的。

等这些会挡路的 insertion 都结束以后，PostgreSQL 才能说：

> 到这里为止，已经是一段完整 WAL 前缀了。

这时候才适合进入真正的 WAL Write。

顺序大概是：

```text
WaitXLogInsertionsToFinish()
              ↓
      WALWriteLock
              ↓
         XLogWrite()
```

而且这里不能随便换。

假设 Flush Backend 先拿 `WALWriteLock`，再去等某个 inserter：

```text
Flush Backend
    │
    ├── 持有 WALWriteLock
    │
    └── 等 Inserter

Inserter
    │
    └── 为了推进 WAL Buffer
        又需要 WALWriteLock
```

两边就可以一直等下去了。

所以先把 WAL 前缀里的洞等平，再拿负责真正写出的锁。

PostgreSQL 没有靠“所有 Backend 串行写 WAL”来保持日志有序。

它只是先串行确定每条 Record 在 WAL Stream 里的位置，再允许大家并发把内容填进去；真正要持久化时，重新收敛到一个完整连续的前缀。

## Group Commit 就藏在这条连续前缀里

假设三个 Backend 差不多同时提交：

```text
A 的 Commit LSN = 120
B 的 Commit LSN = 150
C 的 Commit LSN = 180
```

每个人真正关心的只是：

```text
A：Flush >= 120
B：Flush >= 150
C：Flush >= 180
```

现在 A、B、C 都跑进 `XLogFlush()`。

其中一个 Backend 抢到了 `WALWriteLock`。

如果后面的 WAL insertion 已经完成，它并不需要只写到自己的 Commit LSN，完全可以把当前已经准备好的 WAL 一起写出去。

假设一次 Flush 到了 180：

```text
                 A        B          C
                 │        │          │
                 ▼        ▼          ▼
WAL ────────────120──────150────────180────────>
                                      ▲
                                      │
                                Flush 到这里
```

三个人的等待条件一起满足。

这里有个细节值得注意。

另外两个 Backend 没抢到 `WALWriteLock` 时，并不是排好队：“A 刷完以后轮到 B，B 刷完轮到 C”。

`XLogFlush()` 用的是类似：

```c
LWLockAcquireOrWait(WALWriteLock, LW_EXCLUSIVE)
```

的方式。

如果锁正在别人手里，当前 Backend 会等那个人做完，但不会理所当然地接过锁继续刷。

它回到前面重新看一眼：

```c
if (record <= LogwrtResult.Flush)
    return;
```

A 刚才已经把 Flush LSN 推到了 180。

B 一看，我只等 150。

走了。

C 一看，我等的 180 也到了。

也走了。

所以 PostgreSQL 的 Group Commit，并不太像：

```text
先凑一组事务
     ↓
选一个 Leader
     ↓
统一提交这一组
```

至少在这里，它不需要一份显式的“本批事务成员表”。

所有 Backend 本来就在同一条 WAL Stream 上，等的又是同一个单调前进的 Flush LSN。谁把它推得足够远，前面一串事务自然就一起完成了。

所以前面的并发 insertion 和这里的 Group Commit，其实正好是一体两面：WAL 可以并发产生，但最终只能以连续前缀的形式持久化，而多个事务恰好都在等待这个前缀向前推进。

`commit_delay` 只是在这个基础上再赌一把：

拿到写锁的人故意稍等一会儿，看能不能让更多快完成的 WAL insertion 赶上这一次 Flush。

不配置它，Group Commit 本身也照样存在。

## 那 synchronous_commit=off 到底跳过了哪一步？

顺着这个模型再看异步提交，“性能高一点、Crash 可能丢事务”这句话就不用背了。

`synchronous_commit=off` 不会省掉 Commit Record。

它仍然会进入 WAL。

变化的是当前 Backend 不再坚持等：

```text
Flush LSN >= 我的 Commit LSN
```

成立以后才能返回。

异步路径会先记下这笔事务的 Commit LSN，然后继续完成提交，不停下来等 WAL。

于是会出现一个平时不太容易看到的状态：

```text
正在运行的 PostgreSQL

    事务已经 committed
    其他 Backend 已经能看到它
    客户端也收到了 COMMIT


              时间窗口


durable WAL

    还没走到这笔事务的 Commit Record
```

只要 PostgreSQL 继续正常跑，通常没什么。

walwriter 会继续 Flush，其他 Backend 的提交也可能顺手把这笔 WAL 一起带下去。

过一会儿，这个窗口自然消失。

但如果偏偏在这里 Crash，恢复只能相信真正持久化下来的 WAL。

Commit Record 还没进去，这笔事务恢复以后就可能不存在。

所以异步提交暴露出了一个挺有意思的区别：

**PostgreSQL 在当前运行实例里认定一笔事务 committed，和 Crash 以后还能重新证明它 committed，可以短暂地不是同一个时间点。**

同步提交把 durability 放在客户端收到成功之前，所以平时不太容易看到这两个时间点原来可以分开。

但这时候还有另一份东西得跟 WAL 对得上：

`pg_xact`。

## 事务已经 committed，pg_xact 怎么办？

PostgreSQL 平时判断一个 XID 到底是 committed 还是 aborted，不可能每次都跑去 WAL 里翻 Commit Record。

`pg_xact` 保存的就是这类事务状态。

异步提交时，当前运行中的其他 Backend 已经需要看到这个 XID 是 committed，所以这份运行时状态确实会先往前走。

源码里的异步路径大致是：

```c
XLogSetAsyncXactLSN(XactLastRecEnd);

TransactionIdAsyncCommitTree(
    ...,
    XactLastRecEnd
);
```

这里那个 `XactLastRecEnd` 很关键。

这个 LSN 给 `pg_xact` 状态页留下了一条持久化约束：

> 这份 committed 状态依赖这条 LSN 之前的 WAL。

为什么还要记这层关系？

因为内存里先看到 committed 没问题，真正写到磁盘上就不能随便了。

假设 Commit WAL 还没持久化，`pg_xact` 的状态页自己先落盘：

```text
磁盘上的 pg_xact

    xid 42 = committed


磁盘上的 WAL

    没有 xid 42 的 Commit Record
```

两边单独看都像真的，放在一起却解释不通。

所以异步提交允许**运行时事务状态**先往前走，却不能允许这份状态的**持久化结果**跑到 Commit WAL 前面。

`pg_xact` 状态页以后真要写出去，必须先保证它依赖的 WAL 已经 Flush。

这和数据页上的 Page LSN 其实很像。

Heap Page 可以先在 Shared Buffers 里变脏，但要真正写盘，保护它的 WAL 得先 durable。

事务状态页也是同样的约束：

```text
          运行时
             │
             │ 可以先看到 committed
             ▼
      pg_xact 状态改变
             │
             │ 真正持久化前
             ▼
       先检查 Commit LSN
             │
             ▼
       WAL 必须先 Flush
             │
             ▼
      pg_xact 才能安全落盘
```

所以 `synchronous_commit=off` 放松的是当前 Backend 的等待。

它没有把 WAL 和事务状态之间的持久化顺序一起放松掉。

这样才可能做到：事务先返回，durability 后面补，同时最后留在磁盘上的几份状态仍然能互相解释。

## Checkpoint 为什么也会管到这里？

到这里还有最后一个参与者：Checkpoint。

如果对 Checkpoint 不熟，这里先只记一个作用就够了：

**Checkpoint 会不断往前移动 Crash Recovery 的起点。**

数据库当然不可能每次启动，都从集群创建那天开始重放所有 WAL。

Checkpoint 会建立一个新的 Redo Point。

以后发生 Crash，Recovery 可以从这里附近开始往后 replay，而不用重新处理更早那一大段历史。

可以先粗略理解成：

```text
WAL ───────────────────────────────────────────────>

很久以前                     Redo Point          现在
  │                              │                 │
  │   正常情况下，Crash            │                 │
  │   Recovery 不需要从这里之前    │                 │
  │   重新开始 replay              │                 │
  └──────────────────────────────┘
                                 │
                                 └── 以后主要从这里往后恢复
```

当然，旧 WAL 可能还会因为归档、复制等原因继续保留。

这里说的只是 **Crash Recovery 不再依赖重新 replay 它们**。

有了这个背景，再看 Commit 就容易多了。

假设一个 Backend 正卡在提交中间。Commit Record 已经写进 WAL，但对应的 `pg_xact` 状态还没有安全落盘。这时候 Checkpoint 也在进行，新的 Redo Point 完全可能已经落到了这条 Commit Record 后面：

```text
WAL ───────────────────────────────────────────>

        Commit Record
             │
             ▼
─────────────●──────────────│───────────────────
                            ▲
                            │
                      New Redo Point
```

单看这件事还没有问题。

Checkpoint 不是选完 Redo Point 的一瞬间就全部完成了，它后面还要把需要的状态安全刷下去，最后这个 Checkpoint 才真正成为以后可以依赖的恢复边界。

危险的是另一种情况：

**对应的 `pg_xact` 状态还没有被安全持久化，这个 Checkpoint 就已经完成了。**

下一次 Crash 时：

Recovery 从新的 Redo Point 开始。

那条 Commit Record 在 Redo Point 前面，所以不会再 replay。

如果对应的 `pg_xact` 状态也没有被安全持久化：

```text
              Crash 后

Commit Record
    │
    └── 在 Redo Point 前
        Recovery 不会重新 replay


pg_xact
    │
    └── committed 状态又没可靠留下


            ↓

这笔事务到底提交没有？
没人能再证明
```

这就是提交过程里 `DELAY_CHKPT_IN_COMMIT` 要解决的问题。

Backend 进入这段关键提交阶段时，会设置这个标志。

它表达的意思大概是：

> 我的 Commit WAL 和事务状态现在还处在必须一起处理的窗口里，这轮 Checkpoint 先别结束。

Checkpointer 在坐实这个恢复边界之前，会等这些 Backend 越过提交关键区间。

等 Commit Record 和 `pg_xact` 的关系已经处理安全，Backend 才清掉这个标志。

这里有个边界值得注意：

同步复制等待发生在这之后。

也就是说，本地 Commit WAL、`pg_xact` 和 Checkpoint 之间的一致性处理完，Backend 就退出这段 commit critical section。

如果用户还要求等同步备库，再慢慢等远端。

PostgreSQL 不会因为一台备库卡了十秒，让自己一直处在这种本地提交关键状态里。

这样再看 Checkpoint，其实它不是突然跑来参与事务提交。

它只是刚好掌握了另一件同样重要的权力：

> **以后恢复时，哪些旧 WAL 可以不再重新执行。**

Commit Record 是 WAL 对事务结果的记录。

`pg_xact` 是数据库正常运行时保存的事务状态。

Checkpoint 则决定以后 Crash Recovery 还会不会重新看到那条 Commit Record。

三边必须对得上。

如果 Checkpoint 已经允许恢复跳过某条 Commit Record，那么这笔事务的结果就必须已经被其他持久化状态可靠接住。

## COMMIT 到底在等什么

到这里再回头看 `synchronous_commit`，反而不用讲很多。

普通同步提交，Backend 至少等本机：

```text
Flush LSN >= Commit LSN
```

`synchronous_commit=off` 允许当前 Backend 不等，让后面的 walwriter 或其他 Flush 把它补上。

配置了同步备库以后，同一个 Commit LSN 还可以继续往远处走：

```text
local flush
    ↓
standby write
    ↓
standby flush
    ↓
standby apply
```

`local`、`remote_write`、`on`、`remote_apply`，主要就是在选 COMMIT 返回前要等到哪一层。

所以现在再看一次那条最普通的：

```sql
COMMIT;
```

我更关心的已经不是它下面走了多少函数。

前面的 Backend 可以乱序完成各自的 WAL insertion，但真正持久化出去的必须是一段完整前缀；异步提交又允许运行时状态暂时走在 durability 前面，但 WAL、`pg_xact` 和 Checkpoint 最终必须把历史重新对齐。

`synchronous_commit` 做的，就是决定客户端要站在哪条边界后面等。

该等的那条线过去了，PostgreSQL 才把 `COMMIT` 交回来。
