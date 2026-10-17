---
author: Neil Chen
pubDatetime: 2026-10-17T00:00:00+08:00
title: B-tree 里的重复 Key 与旧记录的清理
description: 从一次阻止了 HOT 的普通 UPDATE 出发，解释 Unique Index 为什么允许重复 Key、B-tree 如何在插入路径上清理旧版本，以及 VACUUM 清理完成之后，空间为什么仍可能留在 Index 文件里。
tags:
  - postgresql
  - internals
---

# B-tree 里的重复 Key 与旧记录的清理

给一张表建了 Unique Index，就意味着同一个 Key 不能同时对应两条违反唯一性约束的有效记录。

不过，如果去看 PostgreSQL B-tree 的 Leaf Page，会发现里面可能存着多个相同的 Key。

而且这些重复项不一定来自并发插入，一次普通的 UPDATE 就可能留下这样的结果。

```sql
CREATE TABLE t (
    id int PRIMARY KEY,
    v  int
);

CREATE INDEX t_v_idx ON t(v);

INSERT INTO t VALUES (42, 100);

UPDATE t SET v = 101 WHERE id = 42;
```

这次 UPDATE 修改了 `v`，因此无法使用 HOT Update。Heap 会创建新的 Tuple Version，相关索引也需要插入指向新版本的 Index Tuple。

假设 UPDATE 前后的 Heap TID 分别是 `(10, 3)` 和 `(10, 7)`，主键索引里就可能出现这样的状态：

```text
        Unique Index: t_pkey

        Key       Heap TID
      +------+-------------+
      |  42  |   (10,3)    |  Old Version
      |  42  |   (10,7)    |  New Version
      +------+-------------+
```

两条 Index Tuple 的 Key 相同，指向的 Heap TID 不同。它们对应同一行在不同时刻产生的物理版本。

用 `pageinspect` 可以直接看到这两个 Index Entry：

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;

SELECT itemoffset, htid AS heap_tid, data
FROM bt_page_items('t_pkey', 1)
ORDER BY itemoffset;
```

```text
 itemoffset | heap_tid |          data
------------+----------+-------------------------
          1 | (0,1)    | 2a 00 00 00 00 00 00 00
          2 | (0,2)    | 2a 00 00 00 00 00 00 00
```

两行的 `data` 都是 `int4` 的 `42`，指向的 Heap TID 却不同。这个例子里的 Block 1 同时是 Root 和最右叶页，没有 High Key，所以两行都是真实的 Index Entry。实测 TID 取决于当时 Heap 页面的位置，不必与前文为画图假设的 `(10,3)`、`(10,7)` 相同。

旧版本可能还需要留给之前取得 Snapshot 的事务。即使它已经彻底没有用处，Index 里的记录也不会因为事务提交就自动消失。

这就带来了两个问题：PostgreSQL 怎么判断重复 Key 是否构成唯一性冲突？又怎样清理那些已经失去价值的 Index Tuple，避免 B-tree 不断增长？

## Unique Index 怎样判断重复

B-tree 的物理排序允许相同 Key 对应多个 TID。在 PostgreSQL 的现代 B-tree 中，Heap TID 还可以作为隐含的最后一列排序键，让这些记录拥有确定的物理顺序。

但 Unique Constraint 检查的是用户 Key。判断唯一性时，不能因为 TID 不同，就把它们当成不同的 Key。

一次普通的唯一索引插入，会进入 `_bt_check_unique()` 检查可能存在的重复项。找到相同 Key 后，PostgreSQL 还需要拿着 Index Tuple 中的 Heap TID，回到 Heap 判断对应 Tuple Version 的状态。对于 Heap Table，这个过程还需要考虑 HOT Chain。

因此，单凭 Leaf Page 中存在两个相同 Key，无法判断它们是否构成唯一性冲突。

假设前面 UPDATE 的事务已经提交：

```text
Index Entry (42, TID(10,3))
              |
              v
        Heap Tuple V1
        xmin = 100
        xmax = 200

Index Entry (42, TID(10,7))
              |
              v
        Heap Tuple V2
        xmin = 200
        xmax = Invalid
```

V1 和 V2 是一次 UPDATE 前后的版本。虽然 Index 里留下了两条记录，但它们不会因此变成两条同时违反唯一性约束的有效记录。

把时间拨回 UPDATE 执行的那一刻：插入新版本的索引项时，旧 Heap 版本已经被当前事务标记为更新，因此不会阻挡这次插入。也就是说，**不构成唯一性冲突，并不意味着可以物理删除**——之前取得 Snapshot 的事务仍可能需要旧版本。

麻烦的是，检查时事务状态可能还没有确定。

例如，Session A 插入了 `id = 100`，但还没有提交。Session B 随后也尝试插入 `id = 100`。

```sql
-- Session A
BEGIN;
INSERT INTO t VALUES (100, 1);

-- Session B
INSERT INTO t VALUES (100, 2);
```

如果 A 最后提交，B 应该报唯一性冲突；如果 A 回滚，B 就应该有机会继续插入。

PostgreSQL 使用 `SnapshotDirty` 检查这类情况。它会把尚未结束的事务对 Tuple 的影响纳入判断，让 Unique Check 知道当前的潜在冲突涉及哪个事务。

B-tree 还需要协调并发插入，避免两个 Backend 同时检查、同时发现没有冲突，然后各自插入成功。为此，唯一性检查会暂时忽略 Heap TID 这个排序后缀，先锁住该用户 Key 可能出现的第一个 Leaf Page，让相同用户 Key 的竞争者经过同一个检查入口；检查通过后，写锁一直保护到插入完成。

但这把锁不能一直拿着等另一个事务结束。

因此，遇到尚未确定的冲突时，PostgreSQL 会先释放 B-tree Page Lock，再等待对应事务。等待结束后重新从 Root 搜索，并再次检查唯一性。

```text
找到潜在冲突
      |
      v
释放 Page Lock
      |
      v
等待冲突事务
      |
      v
重新搜索 B-tree
      |
      v
重新检查唯一性
```

如果 A 提交，B 会发现确定的冲突；如果 A 回滚，B 则可以在重新检查后继续插入。

这里的重新搜索也有实际原因：等待期间，目标 Leaf Page 可能已经 Split，原来的 Offset 和搜索边界不一定还有效。

### ON CONFLICT 为什么需要试探性插入

`INSERT ... ON CONFLICT` 还要处理另一种情况：发生冲突时，执行指定的动作，而不是直接让语句失败。

例如：

```sql
INSERT INTO t VALUES (100, 200)
ON CONFLICT (id)
DO UPDATE SET v = EXCLUDED.v;
```

如果 `id = 100` 已经存在，Executor 可以先检查到冲突，直接进入 `DO UPDATE`。但如果两个 Backend 几乎同时插入这个 Key，它们可能都在预检查时发现记录不存在。

这时就需要 **Speculative Insertion（试探性插入）**。

它的思路是：先把 Tuple 插入 Heap 和 Index，但暂时不确认最终保留它。Index 检查完成后，再决定确认还是取消。

```text
预检查没有发现冲突
          |
          v
   插入 Speculative Tuple
          |
          v
      检查 Index
          |
      +---+---+
      |       |
    无冲突   有潜在冲突
      |       |
      v       v
    Confirm  Cancel
      |       |
      v       v
  继续事务   重新检查冲突
```

这里的 Confirm 只表示这次插入决定保留，**不代表整个事务已经提交**。

为了协调这个决定，PostgreSQL 使用 Speculative Insertion Token Lock。另一个 Backend 如果遇到尚未确认的 Speculative Tuple，可以先等待它被确认或取消，而不必立即等待整个事务结束。

如果 Tuple 被确认，它仍可能属于一个尚未提交的事务，等待者之后仍需要根据情况等待事务结果。如果 Tuple 被取消，等待者重新检查时就可以把它当作无效记录处理。

这也解释了一个细节：Speculative Tuple 被取消以后，先前插入的 Index Entry 不一定立即删除。Heap Tuple 已经无效了，但对应的物理索引记录仍可能留在 B-tree 中，等待后续清理。

到这里，重复 Key 的来源就比较清楚了：UPDATE 产生的新旧版本、尚未结束的事务，以及已经取消但尚未物理清理的插入，都可能让相同 Key 的 Index Entry 暂时共存。

这些记录不会直接破坏唯一性约束，却会占用真实的存储空间。

## Page 快满了，先清理还是直接 Split

回到开头的例子。

假如业务不断执行：

```sql
UPDATE t SET v = v + 1 WHERE id = 42;
```

每次 UPDATE 都因为 `v` 索引而无法使用 HOT。即使主键 `id` 始终不变，主键索引也需要插入指向新 Heap TID 的 Index Tuple。

如果每次 Leaf Page 空间不足就直接 Split，这些短暂存在的旧版本就会不断推动 B-tree 增长。

而 Split 发生以后，即使旧记录后来被清理，PostgreSQL 也不会自动把两个部分空闲的 Leaf Page 合并回去。

所以在真正 Split 之前，B-tree 会尝试回收当前 Page 上的空间。这里主要有三种机制。

### Simple Deletion：清理已知可删的记录

Index Scan 在读取 Index Entry 后，有时会发现它指向的 Heap 版本已经确定死亡。这个信息可以顺手记在 Index Page 上，把对应的 Line Pointer 标记成 `LP_DEAD`。

这里容易和 Heap Pruning 里的 `LP_DEAD` 混淆。Heap 侧的 `LP_DEAD` 表示旧 Tuple 的字节已经可以清除，但 Offset Number 还要保留，直到相关 Index Entry 被清理。Index 侧的 `LP_DEAD` 则只是一个可删除提示：对应的 Index Tuple 仍然留在 Leaf Page 上，空间还没有释放。

普通 Index Scan 和 Unique Check 都可能留下这种提示。等到新的 Index Tuple 放不下时，Simple Deletion 就可以依据这些信息，把已知可删的记录真正移除，从而省下一次 Split。当前实现还会利用 Heap Block 的局部性，额外检查一些可能已经死亡的候选 TID。

它的局限也很明显：如果旧 Index Tuple 很少被查询碰到，就未必有人给它们设置 `LP_DEAD`。一张大量 UPDATE、很少查询的表，完全可能已经堆了不少过时记录，Leaf Page 上却没有多少可用的提示。

### Bottom-up Deletion：检查疑似 Version Churn

PostgreSQL 14 引入的 Bottom-up Index Deletion，主要针对的就是这种情况。

回到那张反复更新 `v` 的表。对 `t_v_idx` 来说 Key 确实变了；对 `t_pkey` 来说，新 Index Tuple 的 Key 始终是 `42`，只是 Heap TID 在变。Executor 可以通过 `indexUnchanged` 这样的 Hint 告诉 B-tree：这次更新虽然要插入新 Index Tuple，但索引的逻辑 Key 没有变化。

如果对应 Leaf Page 又恰好要满，PostgreSQL 就有理由怀疑，这里的空间压力主要来自同一逻辑行留下的一串旧版本。

Bottom-up Deletion 会挑出一些疑似 Version Churn 的 Index Tuple，但不能只看 Key 和 TID 就决定删谁，这个判断仍要交给 Table AM：

```text
       B-tree Leaf Page
              |
              | 找出候选 TID
              v
  table_index_delete_tuples()
              |
              v
           Heap AM
              |
              | 检查 Heap Tuple / HOT Chain
              v
       返回可删除的 TID
              |
              v
      删除对应 Index Tuple
```

如果某个 Index Entry 对应的 HOT Chain 里还有不可回收的版本，这条记录就不能删。

这里和 Unique Check 有点像：两者都要回到 Heap，但关心的问题不同。Unique Check 问的是「这个 Key 是否还可能冲突」，Bottom-up Deletion 问的是「这条 Index Entry 指向的版本是否已经可以安全删除」。

不过 Bottom-up Deletion 发生在前台插入路径上，成本必须受控。为了省一次 Split 而随机读取几百个 Heap Block，可能比直接 Split 还贵。因此 PostgreSQL 会结合相同 Key 的分布、Heap Block 的局部性和预计可释放的空间来缩小候选范围，Heap AM 也会在释放足够空间或收益变低时停止。

它的目标是尽量避免 Version Churn 引起的不必要 Split，而不是一次清掉所有旧版本。对于更新频繁、旧版本又能较快越过 Visibility Horizon 的场景，这种局部清理可能让 B-tree 长期保持相对稳定。但如果存在长事务，旧版本迟迟不能回收，即使找到了它们也无法删除。

### Deduplication：把重复 Key 压紧

Page 仍然放不下时，Deduplication 还能再争取一点空间。

它处理的是 Index Tuple 的物理表示。多个相同 Key 的 Index Tuple：

```text
+--------------------+
| key=42  TID=(10,3) |
+--------------------+
| key=42  TID=(10,7) |
+--------------------+
| key=42  TID=(11,2) |
+--------------------+
| key=42  TID=(12,5) |
+--------------------+
```

可以合并成一个 Posting List Tuple：

```text
+-----------------------------+
| key = 42                    |
|                             |
| TIDs:                       |
|   (10,3)                    |
|   (10,7)                    |
|   (11,2)                    |
|   (12,5)                    |
+-----------------------------+
```

原来每条记录都要保存一份 Key、Tuple Header 和 Line Pointer，现在 Key 只存一次，后面跟一组有序的 Heap TID。对于重复 Key 较多的 Leaf Page，能省下不少空间。

Unique Index 同样可能使用 Dedup。多个相同 Key 的 TID 合并后，唯一性检查仍要逐个检查这些 Heap TID，判断是否存在有效冲突。Dedup 也有适用条件，比如 `deduplicate_items` 选项和 Operator Class 的 `equalimage` 支持，PostgreSQL 需要确认合并不会破坏索引的比较语义。

还要注意，Dedup 并没有真正删除任何 Heap TID。四个 TID 合并后仍然是四个；如果其中两个已经死亡、另外两个还要保留，它也不会改变这些状态。等后续 VACUUM 或 Index Deletion 确认部分 TID 可以删除时，再把死亡 TID 从 Posting List 中去掉；如果所有 TID 都可删，才移除整个 Posting List Tuple。

如果这三招都不足以容纳新记录，B-tree 最终仍然需要 Split。它们能减少不必要的结构增长，但不能保证 B-tree 永远不膨胀。

到这里可以小结一下：**B-tree 主要通过插入路径上的局部清理与压缩，减少旧记录带来的空间压力。** Simple Deletion 处理已知可删的提示，Bottom-up Deletion 主动检查疑似 Version Churn，Deduplication 把重复 Key 压紧。它们都在 Split 之前尽量争取空间，尽量避免一次结构修改。

## VACUUM 怎样完成跨索引的清理

前面的清理都集中在当前有空间压力的 Leaf Page 上。如果某个 Page 长期没有新记录插入，它即使积累了不少旧 Index Tuple，也未必会触发 Bottom-up Deletion。

更重要的是，Heap 不能一直等着这些局部清理碰巧发生。

上一篇《Heap Page 里的旧版本，什么时候会被清理》已经讨论过：Heap Pruning 可以移除旧 Tuple 的字节，但对于仍可能被 Index 引用的 TID，需要先把 Line Pointer 留在 `LP_DEAD`。只要旧 Index Entry 还存在，Heap 就不能把对应 Offset Number 随意分配给另一条记录。

否则会出现：

```text
Old Index Entry
       |
       v
TID = (42,7)
       |
       | Heap 提前复用 TID
       v
New Unrelated Tuple
```

一条旧 Index Entry 就可能指向完全不相关的新记录。

VACUUM 要解决的正是这段跨 Heap 和 Index 的清理工作。Heap Scan 先确定哪些 TID 已经可以回收，收集成 Dead TID 集合，再让表上的各个 Index 清理这些 TID 对应的 Index Entry。所有相关 Index 清理完成以后，Heap 才能把相应的 `LP_DEAD` 转成 `LP_UNUSED`。

```text
           Heap Scan
               |
               v
       收集 Dead TID
               |
               v
         Index Vacuum
               |
       +-------+-------+
       |               |
       v               v
    Index A         Index B
       |               |
       +-------+-------+
               |
               v
       Index 清理完成
               |
               v
       回到 Heap Page
               |
               v
      LP_DEAD -> LP_UNUSED
```

B-tree 通过 `btbulkdelete()` 接入这个过程。它按物理 Block Number 扫描 Index Page，检查各条 Index Tuple 指向的 TID 是否属于 Heap 提供的死亡集合。普通 Index Tuple 对应 TID 已死就可以删除；Posting List 如果只有部分 TID 死亡，就更新这条 Posting List，保留仍然需要的 TID。

这里的 VACUUM 和 Bottom-up Deletion 有个重要区别。Bottom-up Deletion 只在局部 Page 面临 Split 压力时，顺手清理一些旧版本；VACUUM 则要根据 Heap 已经确定的死亡集合完成跨 Index 的清理，让 Heap 后续能够安全复用 TID。

### 删除 Index Tuple 也要等扫描者

B-tree VACUUM 处理 Leaf Page 时，需要使用 Cleanup Lock。拿到 Cleanup Lock，意味着没有其他 Backend 还 Pin 着该 Buffer。

一个已经确认死亡的 Index Tuple，为什么删除前还要关心别人有没有 Pin 着它所在的 Page？

考虑一个 Index Scan：它可能刚从 Leaf Page 取出一个 TID，接下来准备去 Heap 访问对应 Tuple。如果 VACUUM 同时清理了这条 Index Entry，又允许 Heap 立即复用原来的 TID，那么扫描者手里的地址就可能指向另一条完全不同的 Tuple。某些 Index Scan 会在访问 Heap 期间继续保留 Leaf Page Pin，Cleanup Lock 可以等这些使用者离开后再推进清理。

而「没有待删记录的页也要加锁」，是另一个独立的问题。假设 Index Scan 从 A 页复制了一个 TID，并继续持有 A 页的 Pin；随后一次 Split 把对应记录搬到了 B 页。VACUUM 即使已经在 B 页删除了索引项，也还要等这个 Pin 着 A 页的扫描者结束相关访问，才能完成「允许 Heap TID 复用」的清理协议。Cleanup Lock 要保证的，正是这一点。

所以 `btbulkdelete()` 即使在某个 Leaf Page 上没有可删除的 Tuple，也需要取得 Cleanup Lock。这是整个 Index VACUUM 与并发扫描之间的同步要求。而前台 Simple Deletion 和 Bottom-up Deletion 没有后续让 Heap TID 立即可复用的承诺，所以不必承担同样的全局清理要求。

此外还有并发 Split 带来的漏扫问题：B-tree VACUUM 按物理 Block Number 扫描，而 Index Scan 按 Key 顺序前进，并发 Split 可能把一些 Index Tuple 移到物理 Block Number 更小、VACUUM 已经扫过的 Page。PostgreSQL 使用 VACUUM Cycle ID 识别相关 Split，并在必要时沿 Rightlink 回头检查，避免漏扫。

## Index Tuple 删完以后，Page 怎么办

假设 VACUUM 已经把某个 Leaf Page 上的 Index Tuple 全部删除，这个 Page 现在空了。

PostgreSQL 可以进一步尝试把它从 B-tree 结构中删除，但不会直接把这个 Page 交给新的 Index Tuple 使用。

Page Deletion 分两个阶段。第一阶段，调整 Parent Downlink，让搜索不再依赖这个空 Page，并把它标记成 `BTP_HALF_DEAD`；这时 Page 仍然留在同层的 Sibling Chain 中。第二阶段再调整 Sibling Links，把它从链中 Unlink，并标成 `BTP_DELETED`。两个阶段分别有 WAL 记录，即使删除中途被打断，后面的 VACUUM 也能根据留下的状态继续处理。

但到了 `BTP_DELETED`，Page 仍然不能马上复用。之前的 Index Search 或 Scan 可能还保留着旧的导航信息，Page 虽然已从正常搜索结构中移除，却还需要暂时保留原来的物理身份和链接信息，帮助这些使用者安全前进。PostgreSQL 在 Deleted Page 上记录 `safexid`，等相关的旧 Snapshot 和事务都不再构成风险以后，才能把它登记到 Index 的 Free Space Map。

```text
Empty Leaf Page
       |
       v
   HALF_DEAD
       |
       v
    DELETED
       |
       v
等待安全复用条件
       |
       v
    Index FSM
       |
       v
以后被新的 Page Split 复用
```

这和前面 Heap TID 的清理有些相似：Index Tuple 可以先删除，但 Heap TID 的复用要遵守顺序；B-tree Page 可以先从树中删除，但它原来的物理身份也要保留一段时间，直到不再有人可能沿着旧路径找到它。

## VACUUM 跑完了，Index 为什么还是那么大

即使 Autovacuum 正常运行，一张更新频繁的表的 Index 文件也可能越来越大。结合前面的过程，主要有几种情况。

首先是旧版本还不能删除。比如长事务持有很老的 Snapshot，Visibility Horizon 迟迟无法推进。Bottom-up Deletion 和 VACUUM 即使找到这些旧记录，也只能继续保留。Dedup 可以把它们压紧一点，但没有减少需要保护的 TID 数量。

另一种情况是旧 Index Tuple 已经删除，Leaf Page 却只是变得稀疏：

```text
Before VACUUM

[ Page A 90% ][ Page B 95% ][ Page C 85% ]


After VACUUM

[ Page A 30% ][ Page B 40% ][ Page C 20% ]
```

这些 Page 都有了空闲空间，后续插入可以重新利用。但 PostgreSQL B-tree 不会为了提高密度，自动把三个部分空闲的 Leaf Page 合并成一个 Page。

这是并发 B-tree 的一个工程取舍。移动不同 Page 上的 Index Tuple，不仅要调整父节点和 Sibling Link，还要考虑正在沿 Key 顺序扫描的 Backend。特别是向左移动现有记录，可能让反方向扫描的读者漏掉原本应该看到的内容。为了回收一些尚可利用的空间而引入这么复杂的并发结构维护，未必划算。

所以 PostgreSQL 更倾向于继续利用现有 Page 的空闲空间。稀疏叶页里的空闲空间，需要后续插入落入相应的 Key Range 才能利用；已经安全回收并登记到 FSM 的整页，则可以供后续页面分配使用。即使这些空间暂时没有被复用，Index 文件也不会因此自动缩小。

这也是为什么 Index Bloat 不能只看一次 VACUUM 清理了多少条记录。使用 `pgstatindex()` 可以观察 Leaf Page 密度、Deleted Page 数量等信息，再结合业务更新模式、长期事务和 Index 大小变化，判断空间到底卡在哪个阶段。如果大量空间已经留在 Index 内部、又很难被后续写入有效利用，`REINDEX` 可以通过重建获得更紧凑的结构；但它有额外的 I/O、空间和维护成本，并不适合把每次 Index 增长都交给它解决。

## 回到最开始那条 UPDATE

最开始只是执行了一次：

```sql
UPDATE t SET v = 101 WHERE id = 42;
```

主键没有改变，但由于另一个索引阻止了 HOT Update，主键索引仍然产生了一条指向新 Heap TID 的 Index Tuple，于是 Unique Index 里留下了两个相同的 Key。

这些物理重复不会直接破坏唯一性约束。新记录插入时，Unique Check 需要结合 Heap 版本和事务状态判断它们是否构成冲突；涉及未提交事务时，还要释放 Page Lock，等待结果，再重新搜索检查。`ON CONFLICT` 进一步允许一次插入在确认冲突之前保持可取消状态，使并发竞争能够由 Executor 正常处理，而不必直接让语句失败。

旧记录则随着版本生命周期逐渐失去价值。插入路径借助 Simple Deletion、Bottom-up Deletion 和 Deduplication 控制局部空间压力，尽量少做原本可以避免的 Page Split；VACUUM 再根据 Heap 的清理进度，把旧 Index Entry 清理干净，让 Heap TID 最终能够安全复用；空 Page 也可以在满足条件后重新交给 B-tree 使用。

这样看，即使 Key 始终不变，索引也可能在反复更新中持续积累物理版本。最终长到多大，取决于这些版本产生、清理和空间复用的相对速度。