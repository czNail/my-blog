---
author: Neil Chen
pubDatetime: 2026-11-07T00:00:00+08:00
title: PostgreSQL 的 MVCC 读路径，为什么读一次会改页面
description: 从一次 UPDATE 留下的两个 Tuple 版本出发，理解 PostgreSQL 如何结合快照判断可见性，以及读取过程中写回 Hint Bit 的原因。
tags:
  - postgresql
  - internals
---

# PostgreSQL 的 MVCC 读路径，为什么读一次会改页面

一次 `UPDATE` 不会覆盖旧 Tuple，而是在 Heap 中留下两个版本。旧版本记录淘汰它的事务，新版本记录创建它的事务。读取时，PostgreSQL 根据当前快照决定返回哪个版本。

读取也不总是只读页面。判断 Tuple 可见性时，PostgreSQL 可能查询事务状态，并把确认过的结果写回 Tuple Header。这样的标记称为 Hint Bit。它缓存的是事务结果，快照保存的则是读者自己的可见性边界。

## 一次 UPDATE 留下两个版本

假设表中原来有一行 `value = 10`，由已经提交的事务 100 创建。事务 120 把它更新为 20。

Heap 中留下两个版本：

```text
                 XID 120: COMMITTED

       Old tuple                         New tuple
  +----------------------+          +----------------------+
  | value = 10           |          | value = 20           |
  | xmin = 100           |          | xmin = 120           |
  | xmax = 120           |          | xmax = INVALID       |
  +----------------------+          +----------------------+
```

旧版本的 `xmax` 和新版本的 `xmin` 都是 120：前者记录更新者，后者记录创建者。

A 在 120 仍然运行时取得快照，B 则在 120 提交并退出后取得快照：

```text
                 Old tuple       New tuple
A: snapshot excludes 120
                 visible: 10      invisible

B: snapshot accepts 120
                 invisible        visible: 20
```

A 读到旧版本，B 读到新版本。这里不能只检查 `xmin` 和 `xmax` 对应的事务是否提交。事务是否提交，与这笔提交是否落在当前快照的可见范围内，是两个问题。

`HeapTupleSatisfiesMVCC()` 先检查创建者 `xmin`，再检查淘汰者 `xmax`。对普通 Tuple，判断过程可以归结为两个问题：

- 创建这个版本的事务，对当前快照是否已经生效？
- 如果创建已经生效，淘汰这个版本的事务，对当前快照是否已经生效？

旧版本由 100 创建，创建者已经提交，因此还要看 `xmax = 120`。A 的快照排除 120，这次更新对 A 尚未生效，旧版本继续可见。B 的快照不再排除 120，确认它已经提交后，旧版本才会被淘汰。

新版本的判断正好相反：A 的快照排除创建者 120，因此看不到新版本；B 的快照接受 120，确认提交后，才能看到新版本。

**同一笔更新必须在两个版本上得到一致的解释：旧版本被淘汰时，新版本也应当创建；旧版本仍然有效时，新版本就不能提前出现。**

### Hint Bit 记录提交结果，不记录可见性

假设新版本还没有 `HEAP_XMIN_COMMITTED`。A 读到它时，先通过 `XidInMVCCSnapshot(120, snapshot)` 判断 120 是否仍被自己的快照排除。如果是，创建者对 A 尚不可见，判断到此结束，不必再去 `pg_xact` 查询 120 后来是否提交，也不需要为 A 设置 Hint Bit。

B 的快照不再排除 120，才需要调用 `TransactionIdDidCommit(120)`。确认提交后，PostgreSQL 才有条件尝试设置 `HEAP_XMIN_COMMITTED`。

之后 A 再读同一页，也会看到这个标记，但仍须检查自己的快照。Hint Bit 省掉的是事务结果查询，不是可见性判断。

所以，B 可能在旧版本上补上 `HEAP_XMAX_COMMITTED`，在新版本上补上 `HEAP_XMIN_COMMITTED`。A 即使看见这两个标记，仍然返回 10：页面记录 120 已经提交，A 的快照则仍然排除 120。

创建者已经 Frozen 时，创建端才可以跳过普通 XID 的快照检查；版本后来是否被更新或删除，仍要检查 `xmax`。

如果 120 回滚，结果同样是对称的：新版本创建失败，旧版本的淘汰也失败。但 `TransactionIdDidCommit()` 返回 false，并不能单独证明事务已经回滚，运行中的事务也还没有提交。只有快照检查已经排除“仍按未完成处理”的情况，这个 false 才能说明事务没有成功提交。崩溃前未完成的事务也会被归入这一侧。

`xmax` 也不一定指向一个普通更新事务。它可能是无效值，也可能只记录行锁；还可能是包含多个成员的 MultiXact。前两种情况都不会淘汰 Tuple。遇到 MultiXact，需要先找出真正的 updater，再判断更新是否生效。即使 updater 已经失败，其他成员的行锁仍可能有效，因此不能把整个 MultiXact 一并标记为无效。

## 快照必须来自一个一致的时刻

前面的判断都依赖快照对 120 的记录。这个状态不是扫描 Tuple 时临时查询的，而是在取快照时采集的。采集过程必须保持一致，否则后面的可见性判断即使没有错误，也可能选出不可能同时存在的版本。

看一个有依赖关系的更新：

事务 120 把 10 更新为 20。事务 130 也要更新这一行，因此必须等待 120 释放行锁。120 完成后，130 才能把 20 更新为 30 并提交。

如果快照采集先看到 120 仍在运行，随后又看到 130 已经完成，就可能得到下面的判断：

```text
XID 100             XID 120              XID 130
create 10  -------> update 20  --------> update 30
                         |                    ^
                         +---- 130 waits -----+

错误快照：
  120 = in progress  -> 认为 10 尚未被淘汰
  130 = completed    -> 认为 30 已经创建

结果：10 和 30 同时可见
```

130 必须等 120 完成并释放锁才能继续，因此上面的快照不可能对应任何真实时刻：它排除了 120 的修改，却接受了依赖 120 的 130，结果就是 10 和 30 同时可见。

问题不在 Tuple 判断，而在快照采集。PostgreSQL 必须保证，运行事务集合与完成边界是在同一套并发约束下取得的，不能把有先后依赖的事务拼成矛盾的状态。

### 提交结果与运行状态之间的交接

事务提交时，相关动作有固定顺序：

```text
RecordTransactionCommit()
    |
    |  pg_xact 可以查到 COMMITTED
    v
ProcArrayEndTransaction()
    |
    |  从运行事务集合中移除 XID
    v
释放事务锁
    |
    v
等待该事务的 Backend 可以继续
```

`RecordTransactionCommit()` 先发布提交结果，`ProcArrayEndTransaction()` 再从 ProcArray 撤下 XID，最后才释放事务锁。

所以，在前两步之间，下面两个函数可以同时返回 true：

```text
TransactionIdDidCommit(120)    = true
TransactionIdIsInProgress(120) = true
```

这并不矛盾：提交结果已经发布，但事务还没有从运行集合中退出。

这个顺序也决定了实时状态检查的查询顺序。若先查 `pg_xact`，读者可能得到“尚未提交”；随后提交者发布结果并退出，读者再查 ProcArray，又得到“不在运行”。两次查询各自都正确，组合起来却得到了一个从未存在过的状态。

因此，需要检查实时状态时，应先调用 `TransactionIdIsInProgress()`。事务仍在运行，就按未完成处理；确认它已经退出后，再查询提交结果。

普通 MVCC 读取则使用 `XidInMVCCSnapshot()`，判断这个 XID 在当前快照中是否仍应按运行中处理。事务的先后关系已经在取快照时确定，扫描 Tuple 时可以直接使用这份结果，不必反复查询 ProcArray。

`GetSnapshotData()` 持有共享模式的 `ProcArrayLock` 采集运行事务；事务退出 ProcArray 则需要这把锁的排他模式。采集期间，提交者可以先把结果写入 `pg_xact`，却不能从运行集合中退出。事务锁要等退出之后才释放，因此依赖它的 130 也无法提前完成。

这把锁保护的正是快照采集与事务退出之间的顺序，不需要暂停其他事务活动。

### 用边界和运行集合表示快照

快照用 `xmin`、`xmax` 和 `xip` 概括取快照时的事务状态：

- `xmin` 和 `xmax` 划定需要考虑的 XID 范围。
- `xip` 保存两个边界之间仍在运行的事务。
- 小于 `xmin` 的 XID 可以直接排除；不小于 `xmax` 的 XID 按尚未完成处理。

例如：

```text
snapshot.xmin = 120
snapshot.xmax = 124
snapshot.xip  = {120, 122}
```

`XidInMVCCSnapshot()` 先做范围判断，只有落在中间区间的 XID 才需要查 `xip`：

```text
             xmin = 120                 xmax = 124
                  |                         |
                  v                         v
  ----------------+-------------------------+----------------
       XID < 120       120 <= XID < 124          XID >= 124
  ----------------+-------------------------+----------------
       直接放行          查询 xip                  按运行中处理
                       120：在名单中
                       122：在名单中
```

XID 不在 `xip` 中，只说明它在取快照时已经结束，并不能说明它提交成功。需要时仍要查询事务结果。

快照能否复用，也不能只看 `xmax`。120 退出后，最大完成 XID 仍可能是 123，上界不变，但 `xip` 已经变化：

```text
                         120 退出前       120 退出后
snapshot.xmin                120              122
snapshot.xmax                124              124
snapshot.xip             {120, 122}           {122}
```

`GetSnapshotDataReuse()` 通过 `xactCompletionCount` 判断事务数组能否复用。带 XID 的事务退出，以及部分撤销 SubXID 的路径，都会更新这个计数；计数未变，就可以跳过重新采集。

READ COMMITTED 的每条语句都要取得新的快照，但事务完成计数未变化时，可以复用事务数组，仍需更新 `curcid`。REPEATABLE READ 则继续使用事务级快照，不会因共享事务状态变化而重建自己的可见性集合。

Tuple 的 `xmin` 或 `xmax` 也可能是 SubXID。正常情况下，快照通过 `subxip` 检查子事务；子事务缓存溢出后，名单中的缺项不再能说明事务已经结束，`XidInMVCCSnapshot()` 需要通过 `pg_subtrans` 找到顶层事务，再判断它是否在快照中。

`TransactionIdDidCommit()` 遇到 `SUB_COMMITTED` 时也可能沿父链查询，但它要确认的是子事务是否随父事务最终提交。快照检查决定当前读者是否排除这笔修改，提交状态查询确认修改最终是否成功。

## 同一个事务内部的版本变化

XID 区分不同事务，却无法区分同一事务内部的先后修改。这个区别可以从一条 SQL 看出来。假设表中当前值是 20：

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;

WITH changed AS (
    UPDATE mvcc_read_demo SET v = 30 WHERE id = 1
    RETURNING v
)
SELECT (SELECT v FROM mvcc_read_demo WHERE id = 1) AS from_heap,
       (SELECT v FROM changed) AS from_returning;
-- from_heap = 20, from_returning = 30

SELECT v FROM mvcc_read_demo WHERE id = 1;
-- 30

COMMIT;
```

同一条语句里，`RETURNING` 已经返回 30，基表扫描却仍然读到 20；下一条语句再扫描，才会读到 30。

原因是修改 CTE 和主查询使用同一份快照。主查询扫描基表时仍受本条命令的可见性边界约束，`RETURNING` 则直接返回 UPDATE 产生的新值，并没有重新从 Heap 读取。

`cmin` 和 `cmax` 记录 Tuple 在当前事务中的创建和淘汰命令。假设命令 2 创建旧版本，命令 5 更新它：

```text
旧版本：cmin = 2, cmax = 5
新版本：cmin = 5
```

`curcid` 决定当前扫描能看到哪个命令之前的修改：

| `curcid` | 旧版本 | 新版本 |
| --- | --- | --- |
| 5 | 创建已生效，淘汰尚未生效：可见 | 创建尚未生效：不可见 |
| 6 | 淘汰已生效：不可见 | 创建已生效：可见 |

普通 MVCC 扫描只承认命令编号小于 `curcid` 的修改。编号恰好等于边界时，无论是创建还是淘汰，都还不生效。

Executor 将 `es_output_cid` 传给 Heap。命令结束时，`CommandCounterIncrement()` 在当前编号已被使用的情况下推进计数，`SnapshotSetCommandId()` 随之更新工作快照的 `curcid`。REPEATABLE READ 固定的是其他事务的可见性集合；当前事务自己的后续写入，则随着命令边界推进而变得可见。

Tuple Header 只有一个位置保存 CommandId。通常只需保存 `cmin`，或者在后续由其他事务更新时改存 `cmax`；只有创建和淘汰都发生在当前事务中，两个编号才都需要保留。

PostgreSQL 用 Combo CID 将 `(cmin, cmax)` 编码后存入 Header，并设置 `HEAP_COMBOCID`。当前 Backend 通过本地映射还原这对编号，并复用相同组合。映射只需保留到事务结束；由于建立映射可能分配内存，必须在进入修改 Tuple 的 Critical Section 之前完成。

如果更新旧版本的子事务已经回滚，Header 中仍可能留着它的 XID。判断时必须先确认更新者属于当前有效事务树，再比较 `cmax`；不能只看命令编号就淘汰旧版本。

## Hint Bit 写回还要满足什么条件

Hint Bit 缓存的是事务结果，不是可见性结论。写回可以减少后续访问 `pg_xact` 的次数，但必须保证页面与 WAL 的顺序正确。

A 的快照已经把 120 视为运行中。即使 120 此刻已经提交，A 的可见性判断也不会改变。为了设置 Hint 再调用 `TransactionIdIsInProgress()`，只会增加一次全局状态查询，对当前读取没有帮助。因此，这类 Hint 可以留给快照足够新的读者。

需要查询事务结果时，Backend 还可以缓存最近查到的最终状态。`IN_PROGRESS` 和 `SUB_COMMITTED` 仍可能变化，不能放进这份最终状态缓存。

### Committed Hint 必须有 WAL 保护

异步提交时，其他 Backend 可能已经从 `pg_xact` 查到事务已提交，但对应的 Commit WAL 还没有刷盘。

如果这时把 `HEAP_XMIN_COMMITTED` 写进 Heap Page，并且页面先于 Commit WAL 落盘，随后又发生崩溃，Commit WAL 可能丢失。磁盘上的页面却已经记录了这笔提交，恢复时便无法为它找到对应的提交记录。

假设 `TransactionIdGetCommitLSN()` 返回的保护位置是 `C = 800`：

| WAL 已刷到的位置 | Page LSN | 能否设置 committed Hint | 原因 |
| --- | --- | --- | --- |
| 900 | 600 | 能 | Commit WAL 已经刷过 800 |
| 700 | 900 | 能 | 页面写盘前必须先刷 WAL 到 900 |
| 700 | 600 | 不能 | WAL 和 Page LSN 都没有提供保护 |

第二种情况容易忽略。虽然 WAL 只刷到 700，但 Page LSN 已经是 900。页面写盘前必须先把 WAL 刷到至少 900，因此位于 800 的 Commit WAL 也会一并得到保护。

源码中的判断是：

```c
if (XLogNeedsFlush(C) && BufferGetLSNAtomic(buffer) < C)
    return;  /* 暂不设置 committed Hint */
```

条件不满足时，读者不会为了设置 Hint 主动等待 WAL Flush，也不会自行抬高 Page LSN，而是跳过这次写回。后续访问仍可重新检查事务状态。

`C` 是用于保护页面写回的 LSN，不一定等于该事务 Commit Record 的准确位置。CLOG 的共享内存元数据按 XID 分组保存 LSN，组内较晚的提交可能抬高这个位置，让部分本来已经安全的 Hint 延后写入。失败结果的 Hint 不需要这项 committed WAL 保护。

### 页面也必须允许修改

扫描通常已经持有 Buffer Pin 和共享内容锁，但这并不意味着可以直接修改 Tuple Header。

单 Tuple 路径通过 `BufferSetHintBits16()` 申请修改许可；必要时尝试取得 `BUFFER_LOCK_SHARE_EXCLUSIVE`。普通共享读者仍可继续读取，而 Hint 修改与页面写出则受到协调。申请失败时，PostgreSQL 跳过本次写回，可见性结果不受影响。

批量路径 `HeapTupleSatisfiesMVCCBatch()` 让同一批 Tuple 共用 `SetHintBitsState`。第一次需要写 Hint 时才申请许可；申请成功，后续 Tuple 可以复用，申请失败，本批就不再重复尝试。这里复用的是页面修改许可，不同 Tuple 的提交 WAL 条件仍须分别检查。

设置 Hint 会把页面标脏。启用数据校验和或 `wal_log_hints` 时，这次修改还可能触发 Full Page Image。也就是说，一条只读 SQL 确实可能产生脏页，甚至写入 WAL。

## 读者看到的是自己的版本

回到开头的例子。B 确认事务 120 已经提交后，可能把结果写回两个 Tuple；A 随后读到同一页，仍然返回旧版本。

页面保存的是事务结果，快照保存的是读者自己的可见性边界；同一事务内部的修改，再由 CommandId 区分先后。Hint Bit 减少了重复查询事务状态的开销，但它的写回仍受 WAL 和 Buffer 规则约束。

**Heap Page 记录一笔修改是否提交，当前查询的快照决定这笔修改是否对自己生效。**