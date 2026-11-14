---
author: Neil Chen
pubDatetime: 2026-11-14T09:00:00+08:00
title: PostgreSQL 的行锁，写在 Tuple 里
description: 一条 SELECT FOR UPDATE 锁住十万行，pg_locks 里却没有十万条记录。行锁不按逐行对象存进共享锁表，它被写进了 Tuple Header，代价散在 Heap、WAL、MultiXact 和 VACUUM 里。
tags:
  - postgresql
  - internals
---

# PostgreSQL 的行锁，写在 Tuple 里

在 PostgreSQL 里锁十万行，然后去查 `pg_locks`，会发现一件挺奇怪的事：里面几乎没有行锁。

不是视图漏了。行锁的持有状态不作为逐行锁对象保存在 Lock Manager 的共享锁表里。只有发生冲突时，才会使用 heavyweight tuple lock 协调等待。

另一头，一条什么都没改的 `SELECT FOR UPDATE`，可能写出 WAL、弄脏 Heap Page，甚至让已经冻结过的页面重新进入 VACUUM 的视野。

这两件事看着不搭边，根子却是同一个：PostgreSQL 把行锁记进了 Tuple Header。

表锁、事务锁归 Lock Manager 管，状态放在共享内存里。行锁的数量完全是另一个量级，于是 PostgreSQL 换了一套：单个持有者直接写进 Heap Tuple Header 的 `xmax`，多个持有者用 MultiXact 表达，真撞上了，再回头找 Lock Manager 排队。

换来的是行锁不再占锁表容量，代价则散在 Heap Page、WAL、MultiXact 和 VACUUM 里。

## 一把行锁长什么样

先看一条记录被锁住时，Header 上多了什么。

事务 200 执行：

```sql
BEGIN;

SELECT *
FROM accounts
WHERE id = 1
FOR UPDATE;
```

假设这条记录是事务 100 插入的，锁定前后的 Header 大致是这样：

```text
锁定前                         锁定后

+----------------------+       +----------------------+
| xmin = 100           |       | xmin = 100           |
| xmax = Invalid       |       | xmax = 200           |
|                      |       |                      |
| HEAP_XMAX_INVALID    |       | HEAP_XMAX_LOCK_ONLY  |
|                      |       | HEAP_XMAX_EXCL_LOCK  |
|                      |       | HEAP_KEYS_UPDATED    |
|                      |       |                      |
| id = 1               |       | id = 1               |
| balance = 1000       |       | balance = 1000       |
+----------------------+       +----------------------+
```

之前看 Heap UPDATE 时提过，`xmax` 可能代表删除者、更新者，也可能只是一个行锁。行锁借的就是这个字段。区别写在 `t_infomask` 和 `t_infomask2` 里。

`HEAP_XMAX_LOCK_ONLY` 是最关键的一位。有它，读的人就知道这个 `xmax` 只是锁定者，Tuple 没有被淘汰。剩下还有三个强度位：`HEAP_XMAX_KEYSHR_LOCK` 对应 `FOR KEY SHARE`，`HEAP_XMAX_SHR_LOCK` 对应 `FOR SHARE`，`HEAP_XMAX_EXCL_LOCK` 对应排他的两种。

光看 `xmax = 200` 说明不了什么，得连这几位一起读。`FOR UPDATE` 和 `FOR NO KEY UPDATE` 在这一层长得一样，强度位都是 `HEAP_XMAX_EXCL_LOCK`。区别落在 `HEAP_KEYS_UPDATED` 上：`FOR UPDATE` 会设它，`FOR NO KEY UPDATE` 不设。后者没动 key 列，也就不需要挡住外键检查用的 `FOR KEY SHARE`。DELETE 和改 key 的普通 UPDATE 也会设这一位，不过这里只看行锁。

我看着这段代码时，一开始总以为 `FOR UPDATE` 会在内存里挂一把锁，事务结束再摘掉。后来才反应过来，Header 本身就是那把锁。没有额外的对象，没有独立的生命周期，锁状态和 Tuple 长在一起。

普通 MVCC 读取也不关心这些。别人照样能读到 `balance = 1000`。只有准备改、准备删，或者也要锁这一行时，才会去解释 `xmax` 到底是什么意思。

## 为什么不给每把锁建个对象

共享内存里的一把常规 heavyweight lock，要有锁标识、持有者、锁模式、等待队列。它们放在锁表里，所有 Backend 共用。

如果每锁一行就建一个长期对象，十万行就是十万个。锁表还不是想加就加：前面写共享内存那篇提过，main shared memory 在 postmaster 启动时就一次性划好，锁表容量按 `max_locks_per_transaction`、Backend 数量这些参数提前估算。

行锁要是全走这套机制，就得为「业务峰值时可能同时锁住多少行」预留共享内存。

另一个常见思路是 Lock Escalation：行锁攒到一定数量，升级成表锁。语义却变了。本来只锁了表里一小部分记录，升级以后整张表都得等。

PostgreSQL 选了第三条路：让 Tuple 自己记。Header 里本来就有 `xmax`，一个持有者连额外内存都不用分配。两种存法放在一起，大概是这样：

```text
常规锁对象

Transaction A
    |
    +-- Tuple 1 -> Lock Object 1
    +-- Tuple 2 -> Lock Object 2
    +-- ...
    +-- Tuple N -> Lock Object N


PostgreSQL 的行锁

Transaction A
    |
    +-- Tuple 1 [xmax = A]
    +-- Tuple 2 [xmax = A]
    +-- ...
    +-- Tuple N [xmax = A]
```

所以 `max_locks_per_transaction` 不是「一个事务最多能持有多少把锁」的硬上限，更不是行锁上限。它参与锁表容量的估算，锁表本身由所有 Backend 共用——一个事务完全可能用到比这个数更多的锁，只要表里还有空位。行锁根本不进这张表。

## COMMIT 不用逐行清

事务 200 提交，这十万行上的锁就失效了。但 Header 不动，`xmax = 200` 和那几位标志都留在原地。

后来的人访问到这条记录，查一下 200 的状态，就知道它已经结束。锁不再拦人；要记新的锁定者，直接覆盖。锁了十万行，提交时大概是这样：

```text
Transaction 200
    |
    +-- Tuple A: xmax = 200, LOCK_ONLY
    +-- Tuple B: xmax = 200, LOCK_ONLY
    +-- ...
    |
    +-- ... 100000 tuples
    |
    v
  COMMIT

所有行锁失效
Tuple Header 不需要逐条清除
```

如果 commit 必须逐行清，就得把这些记录所在的 Heap Page 再摸一遍——页面数量取决于记录分布，不一定跟行数一样多——再付一遍 Buffer 和 WAL 的开销，还得有一份清单知道到底锁过哪些行。

PostgreSQL 把这件事整个省掉了：释放行锁不需要再逐条改写 Heap Tuple 来清除锁定标志。提交本身当然还有事务状态和 WAL 的事，只是不用为了放锁回头访问每一条记录。

这也是 `xmax` 能一直留着的原因。提交也好，回滚也好，Header 里的旧事务号会躺到 pruning 或 VACUUM 来处理。行锁的「释放」在语义上早就完成了，物理上的清理是另一回事。

不过，一个 `xmax` 只能放一个 XID。多个事务同时锁同一行时，就得换一种记法。

## 一行被多个人锁住：MultiXact

假设 200 已经拿到 `FOR SHARE`，201 随后也拿到一把。两个人可以同时持有兼容锁。

如果 201 直接把 `xmax` 覆盖成 201，200 的锁就丢了。PostgreSQL 用 MultiXact 来存这种多持有者状态：

```text
只有 200 持锁

Tuple
  xmax = 200
  HEAP_XMAX_SHR_LOCK


201 加入

Tuple
  xmax = M1
  HEAP_XMAX_IS_MULTI
        |
        v
    MultiXact M1
    +---------------------+
    | XID 200: FOR SHARE  |
    | XID 201: FOR SHARE  |
    +---------------------+
```

`HEAP_XMAX_IS_MULTI` 表示 `xmax` 里存的是 MultiXactId。真正的成员在 `pg_multixact` 里，读取者要拿这个 ID 去把各个成员的 XID 和状态找出来。

### pg_multixact 里有什么

`$PGDATA/pg_multixact/` 下有两个目录：

```text
$PGDATA/
  |
  +-- pg_multixact/
       |
       +-- offsets/
       |
       +-- members/
```

都是 SLRU 管理的二进制文件，不是 `pg_class` 里的普通 Relation，SQL 也查不到。

`offsets` 解决「M1 的成员从哪开始」。每个 MultiXactId 对应一个 4 字节的 `MultiXactOffset`，指向成员数组在 `members` 里的起始位置。它和 MultiXactId 都是 32 位，却是两个独立的编号空间。

`members` 存成员本身：一个 32 位 XID，加一个状态字节。状态既区分 `FOR KEY SHARE`、`FOR SHARE`、`FOR NO KEY UPDATE`、`FOR UPDATE`，也能标出真正执行 UPDATE 或 DELETE 的成员。

磁盘上的排法挺紧凑。每四个成员打成一组，先放 4 个状态字节，再放 4 个 XID：

```text
Members Group (20 bytes)

+---------------------------+
| Status 0 | 1 byte         |
| Status 1 | 1 byte         |
| Status 2 | 1 byte         |
| Status 3 | 1 byte         |
+---------------------------+
| XID 0    | 4 bytes        |
| XID 1    | 4 bytes        |
| XID 2    | 4 bytes        |
| XID 3    | 4 bytes        |
+---------------------------+
```

源码里还有一点容易混：内存中的 `MultiXactMember` 是 `{xid, status}` 的结构体，对齐之后占 8 字节；磁盘上并不按结构体数组存，而是上面这种 20 字节一组的分组。真按结构体来，4 个成员要 32 字节，比紧凑格式多出 12 字节。

比如 M1 从偏移 120 开始，有 200 和 201 两个成员，M2 就从 122 开始：

```text
Offsets
  M1 -> 120
  M2 -> 122
         |
         v
Members
  120: XID 200, FOR SHARE
  121: XID 201, FOR SHARE
```

相邻两个 offset 一减，前一个集合的长度就出来了。最新的那个集合，用当前的分配位置收尾。

所以 Header 里只存一个 32 位 MultiXactId，就能牵出一整串锁持有者。

### MultiXact 为什么不能原地改

202 也想 `FOR SHARE`。最自然的做法是往 M1 末尾追加一个成员。PostgreSQL 不这么干，它新建一个 M2：

```text
M1 = {200, 201}

202 加入

M2 = {200, 201, 202}

Tuple.xmax: M1 -> M2
```

M1 永远代表 `{200, 201}`。

为什么要费这个劲？因为有人在等。

假设事务 300 要一把和 M1 冲突的锁。它读到 `xmax = M1`，展开成员 `{200, 201}`，然后放掉 Buffer 锁，开始等这两个事务。等的时候不能一直攥着 Page 锁，别人可以继续动这个 Tuple。

如果 M1 能原地追加，这个空档就会变成这样：

```text
Backend 300                     Backend 202

读到 xmax = M1
展开成员 {200, 201}
      |
      |                         想锁同一行
      |                         |
放掉 Page 锁，去等 200、201      |
      |                         原地追加 202
      |                         M1 = {200, 201, 202}
      |
还在按 {200, 201} 等
```

300 当初算出来的等待集合作废了：它等的是 200 和 201，新来的 202 它根本不知道。要不要重新等？等谁？这套协议立刻变得难缠。

新建 M2 就没这个问题。300 等完 200 和 201，重新读 Header，发现 `xmax` 已经变成 M2，那就按 M2 再走一遍。旧的那份状态从头到尾没变过。

代价也在成员数上。A、B、C、D 依次拿兼容锁，而且一直不结束：

```text
M1 = {A, B}          2 个成员
M2 = {A, B, C}       3 个
M3 = {A, B, C, D}    4 个
```

三个 MultiXact，一共记了九个成员。每来一个人，前面的有效成员都要再抄一遍。

`MultiXactIdExpand()` 会按成员状态筛一遍：还在运行的成员要留着；已经结束的纯 locker 可以丢；提交了的 updater 要留，后面读的人还要靠它判断旧版本淘不淘汰；回滚了的 updater 就没用了。如果新事务已经以同样的状态在集合里，直接返回原来的 ID，连新 MultiXact 都不建。

但只要一批兼容锁互相重叠、又都不结束，成员还是会越攒越多。整个过程没有阻塞，MultiXact 的创建、成员复制和 WAL 却一样没少。

## 等锁的时候，pg_locks 里看到什么

Header 和 MultiXact 记的是「谁持有」。真撞上了，还得知道「等谁」。

这里有两层常规锁：`transactionid` 和 `tuple`。

### transactionid：等的是事务

事务拿到正式 XID 后，会在自己的 TransactionId 上拿一把 `ExclusiveLock`，直到事务结束。

A 的 XID 是 200，锁了 `accounts` 里一行。B 也要 `FOR UPDATE`，从 `xmax` 看出持有者是 200，调 `XactLockTableWait()`。底层是在 XID 200 上申请 `ShareLock`，和 A 的排他锁冲突。

| PID | locktype | transactionid | mode | granted |
| --- | --- | --- | --- | --- |
| A | transactionid | 200 | ExclusiveLock | true |
| B | transactionid | 200 | ShareLock | false |

等的是事务，不是行。十万行的 `xmax` 都指向 200，所有等待者用的都是这一个 TransactionId。

`xmax` 是 MultiXact 时，等待路径换成 `MultiXactIdWait()`：先找出与当前请求冲突的成员，再逐个等它们结束。

听着挺省事，问题也在这儿：同一行上排队的两个事务会同时被叫醒。

### tuple：排的是队

再加一个 C，也要锁同一行。

如果 B 和 C 都只等 XID 200，A 一结束，两个人一起醒，谁先抢到 Header 算谁的。更糟的是共享锁：源源不断的 `FOR SHARE` 可以一直插队，让早就排着的 `FOR UPDATE` 永远轮不上。

`README.tuplock` 专门写了这件事，解决办法是在 Lock Manager 里再加一层 tuple lock，只负责排队。

A 持有行锁，B 先撞上，C 随后到：

```text
Backend A              Backend B              Backend C

持有 FOR UPDATE
Tuple.xmax = A
                          |
                      LockTuple()
                      拿到仲裁锁
                          |
                      等待 A 结束
                                                 |
                                             LockTuple()
                                             等 B 让出
                                             仲裁锁
    |
  COMMIT
    |
                      被唤醒
                      重新检查 Tuple
                      记下 xmax = B
                          |
                      UnlockTuple()
                                                 |
                                             拿到仲裁锁
                                             看到 xmax = B
                                             接着等 B
```

顺序就定下来了。B 拿着仲裁锁等 A；C 想插队，得先过 B 这一关。A 结束后 B 被唤醒，重新检查 Header，记下 `xmax = B`，然后才放开仲裁锁。C 这时才拿得到，一看 `xmax` 已经是 B，接着等。

Heap 里那把「锁」还是 B 的，一直有效到 B 的事务结束；仲裁用的 tuple lock 早就还回去了。

整个协议就四步：

```text
LockTuple()
XactLockTableWait()
mark tuple as locked by me
UnlockTuple()
```

`LockTuple()` 用 Lock Manager 里的 tuple 锁排队，`XactLockTableWait()` 等持有者结束。这两层锁在 `pg_locks` 里都能看到。假设 A、B、C 的请求都是 `FOR UPDATE`，并且都卡在上面那个状态，省掉无关记录后大概是这样：

| PID | locktype | mode | granted |
| --- | --- | --- | --- |
| A | transactionid | ExclusiveLock | true |
| B | tuple | AccessExclusiveLock | true |
| B | transactionid | ShareLock | false |
| C | tuple | AccessExclusiveLock | false |

表里的 `transactionid` 是 A 的 XID 200；`tuple` 那两行则靠 `relation`、`page`、`tuple` 字段定位到同一行。

注意 `mode` 那一列：tuple 锁沿用 Lock Manager 的通用锁模式名，`FOR UPDATE` 对应的就是 `AccessExclusiveLock`，不是 `ExclusiveLock`。`FOR NO KEY UPDATE` 才是 `ExclusiveLock`，`FOR SHARE` 是 `RowShareLock`，`FOR KEY SHARE` 是 `AccessShareLock`。这里的锁对象由 `locktype = 'tuple'` 标识，范围只有一条 Tuple，并不表示对整张表拿了 `AccessExclusiveLock`。

想自己复现，可以这样查：

```sql
SELECT pid, locktype, mode, granted,
       relation::regclass AS relation,
       page, tuple, transactionid
FROM pg_locks
WHERE locktype IN ('tuple', 'transactionid')
ORDER BY pid, locktype, granted;
```

这三层别混：

- `transactionid`：常规锁，用来等持有事务结束；
- `tuple`：也是常规锁，只在行锁竞争时出现，负责排队；
- 真正的行锁在 Tuple Header 里，可能挂着一个 MultiXact。

`pg_locks` 里有 `locktype = 'tuple'` 的记录，不代表 Heap 里只有这一把行锁；反过来，锁了十万行却一条 `tuple` 记录都没有，也很正常。没有冲突时，连仲裁锁都不用拿。

为了不让锁表重新被行锁拖下水，一个 Backend 在同一时刻最多持有或等待一把这样的 tuple lock。这个上限不是配置出来的，是协议本身定的。

`SELECT FOR UPDATE` 还会在表上拿 `RowShareLock`，在 `pg_locks` 里是 `relation` 类型。那是表级锁，和行锁不是一回事。

锁升级还有个小例外：一个事务已经持有较弱行锁，又想升级成更强的，如果这行正被多个会话同时锁着、改着或删着，它会跳过 `LockTuple()`。不跳的话可能死锁——它等着仲裁锁，而拿着仲裁锁的人正等着它释放原来那把行锁。

## 行锁也会写页面

`heap_lock_tuple()` 不只改内存。它会改 Tuple Header，需要 WAL 的 Relation 还会写一条 `XLOG_HEAP_LOCK`。

一条 SELECT 也要写 WAL，第一次看到这儿，我确实觉得亏。行锁都活不过事务，为什么还要 WAL？

因为页面上的 XID 是个引用。只要这个 XID 落了盘，就得有一条 WAL 记录能证明它确实被分配过。否则崩溃恢复时，XID 分配可能退回一个更早的位置，200 被重新发给另一个事务，旧 Header 里的 200 就会被当成新事务的状态来读。

`XLOG_HEAP_LOCK` 就是这份证明。

所以它保护的不是锁，是事务编号和持久化页面之间的一致性。锁可以随崩溃消失，页面上的 XID 不能没有出处。

行锁修改会让对应的 Heap Page 变脏，后续需要写回。Checkpoint 后的首次页面修改还可能产生 Full Page Image，因此大量分散的行锁操作可能带来额外 WAL。锁落在越多的页上，这笔成本就越明显。

另外，行锁不会改变 Tuple 的可见性，所以 `ALL_VISIBLE` 可以保留。但新写入的事务标识会使原来的 `ALL_FROZEN` 状态失效，页面之后可能重新进入 VACUUM 的冻结检查范围。

一条只读的 `SELECT FOR UPDATE`，就这样在页面和 WAL 上留下了痕迹。

## MultiXact 谁来收尾

MultiXact 里不一定全是纯 locker。

一个事务拿着 `FOR KEY SHARE`，另一个做了不涉及 key 列的 `UPDATE`。旧 Tuple 的 `xmax` 就得用一个 MultiXact 同时记住两个人：

```text
Old Tuple
  xmax = M1
      |
      v
MultiXact M1
+----------------------------------+
| A: FOR KEY SHARE                 |
| B: NO KEY UPDATE (updater)       |
+----------------------------------+
```

updater 提交以后，读的人还得知道它到底提交没有，才能判断旧版本淘不淘汰。所以这条 MultiXact 不能因为纯 locker 结束就删掉。它得跨崩溃、跨重启活着。

收尾的是 VACUUM。它在冻结 Tuple 时顺手清掉不再需要的成员，推进表的 `relminmxid`；所有库的 `datminmxid` 取最小，汇总进 checkpoint 记录；等 checkpoint 落盘，比这个位置更老的 `pg_multixact` Segment 才能截断。

这里有个容易忽略的地方：一张几乎不 UPDATE、不 DELETE 的表，只要持续产生兼容行锁，MultiXact 照样会涨。每一把新锁都可能要新建 MultiXact、抄一遍成员，而旧成员要等 VACUUM 冻结才能退场。

结果就是，VACUUM 明明没多少 Dead Tuple 可收，却得为了推进 MultiXact 下界把表扫一遍。

## 最后

回到开头。

`SELECT FOR UPDATE` 锁十万行，`pg_locks` 里看不到十万条记录，因为行锁的持有状态不在 Lock Manager 的锁表里。它住在 Tuple Header 的 `xmax` 里；多了就用 MultiXact，冲突了才去 Lock Manager 借一把 tuple lock 排队。

这个设计把行锁从共享内存的容量约束里拿了出来，也把成本摊到了几个地方：

| 机制 | 主要开销 |
| --- | --- |
| Tuple Header | 改 Heap Page、写 WAL |
| MultiXact | 成员存储、扩展复制、历史维护 |
| Lock Manager | 冲突时的 tuple lock 等待 |
| VACUUM | 扫描冻结、推进 `relminmxid` |

所以一笔 `SELECT FOR UPDATE` 到底贵不贵，光看锁了多少行不够。锁分散在很多 Page 上，成本主要落在 Heap 修改、WAL 和后续写页；锁集中在少数热点行，MultiXact 的创建、扩展和历史维护会更显眼；如果这些行本身就在被频繁争用，等待时间和持锁时间又会盖过前两项。

行锁数量是最容易看见的那个数字，却常常不是决定成本的那个。

省下的共享内存不是白省的：行锁能跟着数据量一起长，代价是 Heap、WAL、MultiXact 和 VACUUM 多干一点活。
