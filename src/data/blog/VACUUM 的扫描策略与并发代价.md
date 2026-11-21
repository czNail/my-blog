---
author: Neil Chen
pubDatetime: 2026-11-21T00:00:00+08:00
title: VACUUM 的扫描策略与并发代价
description: 从 Heap 页面扫描、跳页和索引清理出发，分析 VACUUM 各阶段的锁协议，以及 PostgreSQL 如何在维护工作与前台业务之间控制并发代价。
tags:
  - postgresql
  - internals
---

# VACUUM 的扫描策略与并发代价

普通 VACUUM 可以和业务读写同时运行，但它仍然要等。

一张表正在被持续 UPDATE，VACUUM 得进到 Heap Page 里整理旧版本，再回到索引中删掉对应的 Index Tuple。页面里的内容不能随便挪；索引引用还在的时候，Heap TID 也不能交给另一条记录复用。同一时间，业务查询可能正在读这批页面，甚至握着 VACUUM 需要的 Buffer Pin。

这些冲突没有用一把覆盖整张表的强锁来解决，协调工作被拆到了表、Heap Page 和 Index Page 几个层次上：扫描策略决定要访问多少页面，页面锁决定什么时候能改，索引清理保证 TID 可以安全复用。

下面以 PostgreSQL 19 的普通 VACUUM（Lazy VACUUM）为主线，走一遍一次维护的完整过程，看看它在哪些地方会和业务抢资源。

## Heap 扫描与索引清理

一次普通 VACUUM 的主体工作，可以分为 Heap Scan、Index Vacuum、Heap Vacuum 和 Index Cleanup 几个阶段。

```text
Heap Scan
    |
    | Pruning / Freezing，收集 Dead TID 到 TidStore
    |
    | TidStore 满：先做一轮 Index Vacuum 和 Heap Vacuum，再回来接着扫
    |
    | 扫描完成
    v
Index Vacuum
    |
    | 删除对应的 Index Tuple
    v
Heap Vacuum
    |
    | LP_DEAD -> LP_UNUSED
    v
Index Cleanup
    |
    v
Truncate（可选）
    |
    v
Final Cleanup
```

第一遍 Heap Scan 逐页检查，做必要的 Pruning 和 Freezing，把还需要从索引里删掉的 Dead TID 收集起来。PostgreSQL 19 仍然用 `TidStore` 保存这些 TID。

为什么不在这一遍里直接把 `LP_DEAD` 改成 `LP_UNUSED`？

索引里可能还有指向这个位置的 Index Tuple。索引引用没清理干净，这个 Heap TID 就不能被别的记录拿去用。前面的 Heap 清理文章讨论过这条约束，这里只留结论：索引引用清理完成，Heap TID 才能复用。

Index Vacuum 做完，VACUUM 回到 Heap 走第二遍，把对应的 `LP_DEAD` 改成 `LP_UNUSED`。这一阶段叫 Heap Vacuum，只访问 `TidStore` 里记过的页面，不扫全表。

`TidStore` 的大小受 `maintenance_work_mem` 限制；Autovacuum 单独设了 `autovacuum_work_mem` 就用后者，否则还是 `maintenance_work_mem`。

如果 Heap Scan 还没扫完，`TidStore` 已经快满了，VACUUM 会先停下，做一轮 Index Vacuum 和 Heap Vacuum，再从刚才的位置接着扫。大表因此可能来回好几轮，`pg_stat_progress_vacuum` 里 `index_vacuum_count` 大于 1，说的就是这种情况。

最后还有一段常被误解的收尾：Index Cleanup。

Index Vacuum 调的是索引访问方法的 `ambulkdelete()`，真正删除指向 Dead TID 的索引项；Index Cleanup 调的是 `amvacuumcleanup()`，让访问方法做收尾。

以 B-tree 为例，前面跑过 Bulk Delete 的话，Cleanup 一般不用再完整扫一遍索引，更新清理状态和统计信息就够了。前面跳过 Bulk Delete 的话，B-tree 也可能在这里补一次 cleanup-only scan，处理遗留的可回收页面。所以 Index Cleanup 只是访问方法的收尾，不是第二轮删除 Index Tuple。

`INDEX_CLEANUP` 默认是 `AUTO`。它看的不是死项条数，而是 Dead TID 的分布和存储成本：本轮还没做过 Index Vacuum、含 `LP_DEAD` 的 Heap Page 占比很低、`TidStore` 占用也不大时，就可以跳过这一轮的 Index Vacuum 和对应的 Heap Vacuum，末尾的 Index Cleanup 仍可能执行。PG19 的实现里，这两个阈值是总页面数的 2% 和 `TidStore` 的 32MB。

写成 `INDEX_CLEANUP OFF`，则是把 Index Vacuum 和 Index Cleanup 一起关掉，Dead Index Tuple 和对应的 `LP_DEAD` 留给后面的维护。

没有索引的表是个例外：Heap 内部的死项可以直接转成 `LP_UNUSED`，不用等索引清理。

## Heap 扫描范围由 Visibility Map 决定

一张大表并不是每次都要把所有页面重新看一遍。Visibility Map（VM）给每个 Heap Page 存两个标志：

- `ALL_VISIBLE`：页面上的 Tuple 对当前和未来所有事务都可见，没有需要 VACUUM 回收的死版本。
- `ALL_FROZEN`：页面上的 Tuple 已经全部冻结，以后不用再检查事务号是否需要冻结。

`ALL_FROZEN` 必然同时是 `ALL_VISIBLE`。VM 是保守的：标志为 1，说明 PostgreSQL 已经确认条件成立；标志为 0，只说明还没确认，不代表页面里真有垃圾。

这两个标志决定了 Normal 和 Aggressive VACUUM 各要扫多少页面：

| 页面状态                   | Normal VACUUM | Aggressive VACUUM |
| -------------------------- | ------------- | ----------------- |
| 非 All-visible             | 扫描          | 扫描              |
| All-visible、非 All-frozen | 可以跳过      | 必须扫描          |
| All-frozen                 | 可以跳过      | 可以跳过          |

Normal VACUUM 处理当前确实需要清理的页面。已经 All-visible、还没 All-frozen 的页面，它可以先放过。

Aggressive VACUUM 要做完整的冻结检查：页面没到 All-frozen，就不能仅凭 All-visible 断定里面没有需要处理的旧 XID 或 MultiXact ID。一张几乎不 UPDATE、不 DELETE 的大表，在一次 Aggressive VACUUM 里仍然可能被读掉一大片，原因就在这里。

`vacuum_freeze_min_age` 决定哪些事务号可以进入冻结处理，`vacuum_freeze_table_age` 参与判断什么时候该扩大扫描范围，MultiXact 也有对应的年龄参数。

执行 `VACUUM (FREEZE)` 时，PostgreSQL 把四个冻结年龄参数按 0 处理，走 Aggressive 策略，尽量提前做完安全条件允许的冻结。已经 All-frozen 的页面照样跳过，不会被重新读一遍。

另一个容易看错的选项：

```sql
VACUUM (DISABLE_PAGE_SKIPPING) public.t;
```

它关掉所有跳页行为，包括基于 VM 的跳页，也包括为了不等其他会话而跳过页面的那部分，并且强制走 Aggressive 策略。

它和 `FREEZE` 改的不是同一件事：`FREEZE` 调的是冻结年龄条件，`DISABLE_PAGE_SKIPPING` 改的是扫描范围。这个选项留给怀疑 VM 内容不可靠的诊断场景，正常维护没必要开。

### 连续页面与 Eager Scanning

VM 标了某个页面可以跳过，VACUUM 也不一定立刻就跳。PostgreSQL 19 在 `vacuumlazy.c` 里是这么定义的：

```c
#define SKIP_PAGES_THRESHOLD ((BlockNumber) 32)
```

只有连续遇到至少 32 个可跳过的页面，VACUUM 才真的跨过去；零散几个页面，它照样顺着读。VACUUM 本身就是顺序扫描，操作系统能靠连续访问做 Read Ahead，为了省几个页面把顺序读的节奏打乱，未必划算。

扫描范围内的最后一个 Heap Block 总会被访问。VACUUM 得看一眼上面还有没有 Tuple，才能判断表尾有没有可以截掉的空间，省得收尾时再白试一次强锁。

PostgreSQL 19 还有 Eager Scanning。它盯的是 Normal VACUUM 本来能跳过、但还没 All-frozen 的那批页面。

启用要过两道门：表至少 8192 个 Block；本轮的冻结边界得已经越过表的 `relfrozenxid` 或 `relminmxid`，也就是表里确实存在值得提前处理的历史。光是大，不够。

两道门都过了，Normal VACUUM 才会挑一部分页面来扫，顺手把冻结做掉，把将来 Aggressive VACUUM 要承担的读取分摊到多次日常维护里。

代价有明确上限：

- 成功冻结的页面数，最多是 VACUUM 开始时 All-visible、未 All-frozen 页面数的 20%。
- 失败次数按 4096 个 Block 的 Region 统计。
- `vacuum_max_eager_freeze_failure_rate` 默认 3%，某个 Region 里的失败到了上限，就停掉这一区域的额外扫描，换下一个 Region 再试。

成功预算按全表算，是为了让老数据集中在一块时能连续拿到收益；失败预算按 Region 算，是为了不在普遍很新的数据区反复白读。

这套机制不改变冻结的正确性条件，只是调整普通 VACUUM 愿意提前干多少活。冻结本身的页面写入成本，XID64 那篇已经讲过。

### 查询扫描也会更新 VM

PostgreSQL 19 还有一处和 VM 有关的变化：查询的表扫描在访问 Heap Page 时，可以顺带把页面标成 All-visible。

此前，All-visible 标记基本只有 VACUUM 和 `COPY FREEZE` 这类维护或写入路径能设。PG19 把这项能力扩到了 Heap 的按需 Pruning 路径：在符合条件的只读 Heap 扫描里，PostgreSQL 先判断页面值不值得整理，再尝试非阻塞地取得 Cleanup Lock；如果 Pruning 之后保留下来的 Tuple 都已经对所有事务可见，就顺带把 VM 上对应的 All-visible 位设起来。

两个前提要记住：查询计划得把被扫描的关系判定为只读；页面也得真的经过一次整理。所以这不是每次 SELECT 都会发生的操作，查询路径上也不设 All-frozen——冻结仍然要等 VACUUM。

实际效果是，一部分本来要等 VACUUM 才能变成 All-visible 的页面，在业务读取过程中就提前拿到了这个状态。PG19 的 Release Notes 里单独列了这项变化。

### 跳页与冻结边界

Normal VACUUM 跳过 All-visible、未 All-frozen 的页面，代价是它没法据此证明整张表的旧事务历史都处理完了。

PostgreSQL 19 用 `skippedallvis` 记下这次有没有跳过这类页面：跳过了，本次算出来的 `NewRelfrozenXid` 和 `NewRelminMxid` 就不拿去推进表级冻结下界。

这不影响本次 VACUUM 清理其他页面上的 Dead Tuple，也不意味着冻结边界只能靠 Aggressive VACUUM 推进。Normal VACUUM 只要实际把该检查的页面都覆盖到了，一样可以推进。

页面扫了多少、空间回了多少、冻结边界推没推进，是三件事，互相替代不了。

## Heap Page 的 Cleanup Lock 与 Buffer Pin

表级锁放行读写，不代表 VACUUM 就能随时改页面。要做 Pruning、整理 Tuple 和 Line Pointer，它得先拿到 Buffer Cleanup Lock。

这里有两个概念要分开：

- **Buffer Pin**：持有 Buffer 的引用，保证它不会被回收、重新分配给其他页面。
- **Buffer Content Lock**：管的是这块 Buffer 内容上的并发读写。

一个 Backend 访问完页面，可能已经放掉了 Content Lock，却还捏着 Buffer Pin，继续用之前读到的 Tuple 信息。VACUUM 只看 Content Lock 空不空，就可能在别人还在用页面内容的时候把 Tuple 挪走。所以 Cleanup Lock 不光要拿到 Exclusive Buffer Content Lock，还要求当前 Buffer 的 Pin Count 只剩它自己这一个。

这属于 Buffer Manager 的页面清理协议，跟 SQL 层面的表锁没关系。

第一遍 Heap Scan 里，VACUUM 先试一把条件式的 Cleanup Lock：

```c
got_cleanup_lock = ConditionalLockBufferForCleanup(buf);
```

拿不到就退一步。Normal VACUUM 可以降级到 Shared Content Lock，走 `lazy_scan_noprune()`：照样能统计 Tuple、收集页面上已有的 `LP_DEAD`，只是这一轮不做 Pruning 和 Freezing，页面整理留给后面的维护。

Aggressive VACUUM 没这么退让。页面里有本轮必须处理的旧 XID 或 MultiXact ID，就不能简单跳过：先释放共享锁，等 Cleanup Lock，等到了再把页面处理完。它也不是每个页面都无条件等，真正卡住的是那些当前锁条件下干不完、又必须在这一轮干完的页面。

`LockBufferForCleanup()` 在等别的 Backend 放 Pin 时，会先把 Exclusive Content Lock 放掉，再去等 Pin Count 变化，不会整个等待过程都占着页面的排他内容锁。可要是业务查询长期握着 Buffer Pin，VACUUM 还是可能在这儿停很久。

这和长事务挡住旧版本回收是两码事：旧 Snapshot 限定的是哪些版本能删，Buffer Pin 卡住的是 VACUUM 眼下能不能整理这个页面。排查的时候得把两者分开看。

## 索引清理也可能等待

Heap 第一遍扫完，VACUUM 调用索引访问方法的 `ambulkdelete()`，按收集到的 Dead TID 删掉对应的 Index Tuple。

打开索引 Relation 时，VACUUM 用的是 `RowExclusiveLock`。这个 Relation Lock 和普通 Index Scan 需要的 `AccessShareLock` 兼容，扫描索引这件事本身不会互相挡；真正可能等的是后面访问 B-tree 叶子页面时的 Buffer Lock——普通的索引项删除只取排他锁，要删空页时才需要 Cleanup Lock。

以 B-tree 为例，这趟要遍历叶子页面，也可能等别的 Backend 放开页面 Pin。清理协议得保证还在用旧索引项的扫描者把对应的 Heap 访问做完，之后才能安全推进 TID 复用。

并发的搜索和页面清理算法在 B-tree 那篇里讲过，这里只记一句：Heap 扫描结束，不代表 VACUUM 已经完成，索引清理本身也可能是等待点。

索引项删完，VACUUM 回到 Heap，把对应的 `LP_DEAD` 改成 `LP_UNUSED`。这一次只要普通的 Exclusive Buffer Content Lock，不用完整的 Cleanup Lock。

同一个 Heap Page 访问两遍、锁条件不同，是因为要干的活不同：第一遍要保证页面整理和索引引用收集的安全，第二遍是在索引引用处理干净之后释放 Line Pointer。

PG19 还支持并行 VACUUM：

```sql
VACUUM (PARALLEL 4) public.t;
```

并行的是 Index Vacuum 和 Index Cleanup，Heap Scan 不在其中。同一个索引在同一个阶段最多由一个 Worker 处理，要真跑起多个 Worker，至少得有两个够格的索引。写 4 不保证用上 4 个。

## 表尾截断与 REPACK

页面内部腾出来的空间，不会自动让 Relation 文件变短。

Heap 文件尾部要是有一段连续的空页面，VACUUM 可以试着把它们截掉，把空间还给操作系统。可扫描期间业务一直在写，刚才看到的表尾状态可能已经变了，于是 VACUUM 得重新确认表长和尾部页面，还要拿表级 `AccessExclusiveLock`——这把锁跟普通 SELECT 和 DML 都冲突。

普通 VACUUM 在主体阶段不挡读写，到最后这一步 Truncation 仍可能短暂地卡住整张表。

PG19 的 `lazy_truncate_heap()` 是条件式地要这把强锁：拿不到就有限重试，大约 5 秒还拿不到就放弃本次截断。拿到之后还会时不时看一眼有没有新的锁等待者，有人在等就尽量收手。

更在意这一点的业务可以把截断关掉：

```sql
VACUUM (TRUNCATE FALSE) public.t;
```

代价是表尾的空页面留在文件里，等后续插入复用，不还给操作系统。

### REPACK：表重写和物理重组合到一起

PG19 新增了 `REPACK`，用来处理普通 VACUUM 解决不了的另一类问题：表内部大片空闲空间想真正还给操作系统，或者记录的物理顺序要重排。

普通 VACUUM 在原 Heap 上清理旧版本，回收的空间主要留给后续 INSERT 和 UPDATE 复用，通常不会把表文件整体缩小。`REPACK` 走的是另一条路：建一份新的 Heap 文件，把仍然有效的 Tuple 写进去，为新 Heap 重建索引，最后交换新旧文件。指定 `USING INDEX`，还能按指定索引的顺序组织 Heap 里的记录，原来 `CLUSTER` 的物理重组能力也并了进来。

PG19 用 `REPACK` 统一了 `VACUUM FULL` 和 `CLUSTER`，旧命令保留兼容，其中 `VACUUM FULL` 在文档里已经标为 deprecated。

真正值得看的是 `REPACK (CONCURRENTLY)`：

```sql
REPACK (CONCURRENTLY) public.t;
```

普通 REPACK 在重写期间持有 `AccessExclusiveLock`，和传统 `VACUUM FULL` 一样，整张表的读写都得等。

并发模式改的是重写过程中的协议：

1. 用逻辑解码捕获重写期间并发发生的 INSERT、UPDATE、DELETE。
2. 数据复制和索引构建的主体阶段只拿 `ShareUpdateExclusiveLock`，普通读写照常进行。
3. 新 Heap 和索引建好之后，把捕获到的并发修改应用到新文件。
4. 最后拿 `AccessExclusiveLock`，把剩下的修改追完，交换新旧文件。

最耗时的复制和索引构建不再独占整张表，强锁集中在最后的文件交换上。但这不等于没有影响：最后仍要 `AccessExclusiveLock`，并发修改积压多了，追赶阶段也会变长。

还有一个限制得提前说清：`REPACK (CONCURRENTLY)` 不是 MVCC-safe。在重写开始之前就取好 Snapshot 的事务，重写提交之后可能看到一张空表。它不能简单理解成"不会阻塞业务的 VACUUM FULL"。

另外，REPACK 要为新的 Heap 和索引准备额外磁盘空间，重写整张表和所有索引的成本远高于普通 VACUUM，也不适合拿来替代日常防回卷维护。

## 锁兼容不代表没有性能影响

把前面涉及的锁摞在一起看：

| 阶段                  | 主要锁或同步条件                                                               | 对业务的影响                            |
| --------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| 常规 VACUUM           | `ShareUpdateExclusiveLock`                                                     | 普通读写可并发，部分 DDL 和维护操作冲突 |
| Heap 第一遍           | Buffer Cleanup Lock                                                            | 可能等待其他 Backend 释放 Pin           |
| Heap 降级检查         | Shared Content Lock                                                            | 不做页面整理，仍可能与页面写入竞争      |
| B-tree Index Vacuum   | Index Relation `RowExclusiveLock`；叶子页 Buffer Lock（删页时需 Cleanup Lock） | 可能等待索引扫描释放 Pin                |
| Heap 第二遍           | Exclusive Content Lock                                                         | 短暂影响对应页面访问                    |
| 尾部截断              | `AccessExclusiveLock`                                                          | 持有期间阻塞整张表的读写                |
| REPACK                | `AccessExclusiveLock`                                                          | 整个重写期间阻塞整张表的读写            |
| REPACK (CONCURRENTLY) | 主体 `ShareUpdateExclusiveLock`，换文件时 `AccessExclusiveLock`                | 复制和建索引期间可用，收尾短暂阻塞      |
| VACUUM FULL           | `AccessExclusiveLock`                                                          | 整个重写期间阻塞整张表的读写            |

常规 VACUUM 对 Heap Relation 拿的是 `ShareUpdateExclusiveLock`，跟 SELECT 用的 `AccessShareLock`、INSERT/UPDATE/DELETE 用的 `RowExclusiveLock` 都兼容，冲突的是另一轮 VACUUM、ANALYZE、CREATE INDEX CONCURRENTLY 以及部分 DDL。

所谓在线 VACUUM，说的是不用像 VACUUM FULL 那样独占整张表，锁等待还是有的。

而且就算一把锁都不用等，VACUUM 照样吃资源：读写 Heap 和 Index 要占存储带宽，改页面会产生 WAL 和脏页，扫描还要占 CPU 与 Shared Buffers。表大、索引多的时候，这些开销往往比页面锁等待更显眼。

PostgreSQL 为此提供了两个主要的控制手段。

### Cost Delay 与 Buffer Access Strategy

Cost-based Vacuum Delay 给不同类型的页面访问和修改估算成本，累计到 `vacuum_cost_limit` 就让 VACUUM 停一小会儿再继续。它限的不是精确的磁盘带宽，而是维护任务的执行频率，靠放慢节奏压一压瞬时的资源竞争。

PG19 默认手工 VACUUM 的 `vacuum_cost_delay` 是 0ms，Autovacuum 的 `autovacuum_vacuum_cost_delay` 是 2ms。

放慢执行能减轻业务高峰时的资源压力，但 VACUUM 手里的 `ShareUpdateExclusiveLock` 不会因为暂停就放开。维护时间拖长，它跟 DDL 之类的互斥时间也跟着变长。

PG19 还调整了并行 VACUUM 的 Cost Delay 预算：Leader 和并行 Worker 现在共享同一份 Cost Limit，不再各算各的。Worker 数量增加时，总维护成本不会按进程数成倍放大，代价是开了 Cost Delay 的并行 VACUUM 可能比以前慢一些。

另一个是 Buffer Access Strategy。

VACUUM 用一套专门的 Ring Buffer 策略，在一小撮 Shared Buffers 里循环使用，尽量不把业务的热点页面挤出去。PG19 的 `vacuum_buffer_usage_limit` 默认 2MB，也可以用 `BUFFER_USAGE_LIMIT` 覆盖。Ring 调大有时能提高扫描效率，太大了同样会挤掉更多业务缓存。

一个管节奏，一个管缓存用法，都不是 VACUUM 的总 I/O 或 WAL 限额。

### Failsafe 会改变维护优先级

XID 或 MultiXact 年龄碰到 Failsafe 条件，PostgreSQL 会主动丢掉一部分日常优化：停掉 Cost Delay，放弃 Buffer Access Strategy，跳过后面的 Index Vacuum、Index Cleanup 和 Relation Truncation，把力气留给必须做的 Heap 扫描和冻结工作。

要是 Failsafe 在索引清理阶段被触发，后面那遍 Heap Vacuum 也不再执行，没清理完索引的 `LP_DEAD` 留到下次处理。

Failsafe 下的一次 VACUUM 可能少回收一些普通空间，却会多占前台资源。它和 Aggressive 也不是一回事：Aggressive 决定扫多少页面，Failsafe 决定维护工作还能向业务让步多少。

物理备库上还要考虑 WAL 回放冲突：主库 VACUUM 产生的清理和可见性 WAL，可能跟备库上还依赖旧版本的查询撞上，超过备库允许的延迟，PostgreSQL 可能直接把冲突查询取消。主库看不到锁等待，不代表备库查询不受影响。

## Autovacuum：调度和执行是两件事

Autovacuum 没有另写一套 Heap 清理实现。Launcher 安排数据库级的任务，Worker 挑要维护的 Relation，最后走的还是普通 VACUUM 的执行路径。

触发条件不只是 Dead Tuple 数量，还有 INSERT 数量以及 XID、MultiXact 年龄。所以一张只有 INSERT、从不 UPDATE 和 DELETE 的表，也可能被 Autovacuum 找上。

PG19 对 Autovacuum 的改动集中在两处：表的优先级，以及索引清理的并行执行。

### 从触发阈值到表级评分

过去，Autovacuum 看各表有没有到维护阈值，决定要不要处理。PG19 在这之上加了表级评分：Launcher 仍然先挑数据库，进到库里以后，Worker 把需要 VACUUM 或 ANALYZE 的表列出来，按各项指标算分排序。

评分看这几项：`relfrozenxid` 的年龄、`relminmxid` 的年龄、UPDATE / DELETE 产生的 Dead Tuple 数量、INSERT 数量、距上次 ANALYZE 的修改量。每项都有对应的权重参数，最后取各项里的最大值作为表的优先级，分越高越先处理。

比如把 `autovacuum_freeze_score_weight` 调大，冻结年龄在调度里的分量就重；把 `autovacuum_vacuum_insert_score_weight` 调大，插入多的表更容易排到前面。

PG19 还加了 `pg_stat_autovacuum_scores`，能直接看到每张表的总分、各项分数，以及会不会触发 VACUUM、ANALYZE 或防回卷维护。以前只能从日志倒推为什么某张表先被处理，现在有地方看了。

### Autovacuum 也能并行清理索引

PG19 允许 Autovacuum 用并行 Worker 处理索引。相关参数有两个：

- `autovacuum_max_parallel_workers`：单个 Autovacuum Worker 能用的并行 Worker 数量，默认 0，也就是默认不开。
- `autovacuum_parallel_workers`：表级存储参数，默认 -1，表示继承全局值；设成 0 就是这张表不用并行。

实际数量还受 `max_parallel_workers` 和符合条件的索引数目限制。和手工 Parallel VACUUM 一样，并行只覆盖 Index Vacuum 和 Index Cleanup，不含 Heap Scan；每个索引最多分一个 Worker，所以至少要有两个够格的索引，才可能真的跑起多个 Worker。

这也说明 `autovacuum_max_workers` 和 `autovacuum_max_parallel_workers` 解决的不是同一件事：前者决定同时能维护几张不同的表，后者决定单次维护里索引阶段能并行到什么程度。

多个 Autovacuum Worker 同时跑时，Cost Limit 仍会在 Worker 之间平衡；并行 VACUUM 的 Leader 和它的 Worker 共享同一份 Cost Limit。

### 普通任务与防回卷任务

普通 Autovacuum 开始处理一张表时如果拿不到需要的 Relation Lock，可以跳过去。运行中如果前台 Backend 被它持有的锁挡住，锁管理器会认出来，在适当条件下给普通 Autovacuum Worker 发取消信号。不是一有锁冲突就取消，得等锁等待进了检测流程、确认是普通 Autovacuum 挡住了前台，才会走到这一步。

防回卷 Autovacuum 没有这个退让：它不会因为前台等待冲突锁而被自动取消，因为这类维护已经拖不起了。

## 从进度和等待事件判断 VACUUM 卡在哪里

PG19 的进度视图多了两个字段：`mode` 和 `started_by`。配合等待事件，能看出 VACUUM 现在卡在哪：

```sql
SELECT
    p.pid,
    p.relid::regclass AS relation,
    a.backend_type,
    p.phase,
    p.mode,
    p.started_by,
    p.heap_blks_total,
    p.heap_blks_scanned,
    p.heap_blks_vacuumed,
    p.index_vacuum_count,
    p.dead_tuple_bytes,
    p.max_dead_tuple_bytes,
    p.indexes_total,
    p.indexes_processed,
    p.delay_time,
    a.wait_event_type,
    a.wait_event
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a USING (pid)
WHERE p.datname = current_database();
```

几个字段值得留意：

- `mode`：`normal`、`aggressive` 或 `failsafe`。
- `started_by`：`manual`、`autovacuum` 或 `autovacuum_wraparound`。
- `phase`：当前执行到哪个阶段。
- `index_vacuum_count`：已经完成几轮索引清理。
- `dead_tuple_bytes` / `max_dead_tuple_bytes`：Dead TID 攒了多少、预算多大。
- `delay_time`：累计的 Cost Delay 时间；`track_cost_delay_timing` 没打开时这里恒为 0，别误以为 VACUUM 没被节流过。

`heap_blks_scanned` 包含 VM 跳过的页面，表示扫描进度推到了哪个 Block，不是实际读了多少页，更不等于磁盘 I/O 次数。`heap_blks_vacuumed` 是第二遍 Heap Vacuum 的进度，没有 Dead Tuple 的页面会被跳过，所以它也不等于实际改了多少页。

PG19 的等待事件也变过。原来的 `BufferPin` 归入 `Buffer` 类型，名字改成 `BufferCleanup`；原来的 `BufferContent` 拆成了更具体的几个事件：

| 等待事件                        | 含义                                     |
| ------------------------------- | ---------------------------------------- |
| `Lock / relation`               | Relation 级重量级锁冲突                  |
| `Buffer / BufferCleanup`        | 等待取得 Buffer 的独占 Pin 条件          |
| `Buffer / BufferShared`         | 等待 Shared Buffer Content Lock          |
| `Buffer / BufferExclusive`      | 等待 Exclusive Buffer Content Lock       |
| `Buffer / BufferShareExclusive` | 等待 Share Exclusive Buffer Content Lock |
| `IO / DataFileRead`             | 数据文件读取等待                         |
| `Timeout / VacuumDelay`         | Cost Delay 主动节流                      |
| `Timeout / VacuumTruncate`      | 表尾截断相关等待                         |

`pg_locks` 和 `pg_blocking_pids()` 适合查 Relation 级的重量级锁，Buffer Content Lock 和 Buffer Pin 的等待关系它们呈现不出来，页面级的问题还得回来看 `pg_stat_activity.wait_event`。

要看 REPACK 或 VACUUM FULL 的进度，得用 PG19 新增的视图：

```sql
SELECT
    pid,
    relid::regclass AS relation,
    command,
    phase,
    heap_blks_total,
    heap_blks_scanned,
    heap_tuples_scanned,
    heap_tuples_inserted,
    heap_tuples_updated,
    heap_tuples_deleted,
    index_rebuild_count
FROM pg_stat_progress_repack
WHERE datname = current_database();
```

`pg_stat_progress_repack` 同时报告 REPACK、CLUSTER 和 VACUUM FULL 的进度，旧的 `pg_stat_progress_cluster` 保留兼容。

一轮 VACUUM 花多久，取决于要访问多少 Heap 页面、索引里有多少 Dead TID 要处理，以及这些页面能不能顺利拿到清理所需的锁。只看表大小或者 Dead Tuple 数量，很难说清一次维护会给业务带来多大压力。

PostgreSQL 把表级锁、页面级锁和索引清理协议拆开处理，普通 VACUUM 因此不用独占整张表，也能保证 Heap 与 Index 之间的 TID 回收安全。它消不掉所有等待和资源竞争，只是尽量把阻塞限制在真正需要保护的操作上。
