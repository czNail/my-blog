---
author: Neil Chen
pubDatetime: 2026-11-28T00:00:00+08:00
title: 并发更新中的 WHERE 条件：从 EPQ 到 SSI
description: 从一条同时检查任务状态和资源池容量的 UPDATE 出发，看 PostgreSQL 如何通过 EPQ 处理并发版本变化，又如何利用 SSI 和谓词锁检测跨行的读写冲突。
tags:
  - postgresql
  - internals
---

# 并发更新中的 WHERE 条件：从 EPQ 到 SSI

假设一个任务调度系统，任务按资源池划分，每个池最多允许两个任务同时运行。资源池 1 里有三个任务：

```text
 id   pool_id   running   priority
 ---------------------------------
  1      1       true        0       正在运行
  2      1       false       0       等待启动
  3      1       false       0       等待启动
```

`running` 表示任务是否在运行，`priority` 是调度优先级。现在想启动任务 2：

```sql
UPDATE task
SET running = true
WHERE id = 2
  AND pool_id = 1
  AND NOT running           -- 任务尚未启动
  AND (
      SELECT count(*)
      FROM task
      WHERE pool_id = 1
        AND running
  ) < 2;                    -- 资源池还有剩余容量
```

这条 UPDATE 把检查和修改放在同一条语句里：任务本身还没运行，池里正在运行的任务不到两个，才把 `running` 改成 `true`。

单独执行没有问题。并发下，别的会话可能改任务 2，也可能在同一池里启动任务 3。

之前看 MVCC 读路径，关注的是 Snapshot 怎么决定一个 Tuple 可见不可见。UPDATE 多了一步：Executor 不仅要把 Tuple 找出来，还得改它。从找出来到改下去，WHERE 依赖的数据可能已经变了。

这篇沿着这条 UPDATE 往下看。文中的并发行为都在 PostgreSQL 19.0 上，用独立 Backend 连接验证过。

## 两个事务，同时启动任务 2

先让 A、B 都在 READ COMMITTED 下启动任务 2。A 先改，不提交；B 随后执行同样的 SQL。

```text
Transaction A                 Transaction B
------------------------      ------------------------
BEGIN;

UPDATE 任务 2
  running = true
  （未提交）
                              BEGIN;

                              执行同一条 UPDATE
                                running = false
                                运行任务数 = 1
                                WHERE 成立
                                      |
                                尝试修改 Tuple
                                      |
                                    等待 A
                                      |
COMMIT; ----------------------------> |
                                      v
                                  UPDATE 0
```

B 开始执行时，A 还没提交。B 的语句级 Snapshot 里，任务 2 还是 `running = false`，池里只有任务 1 在跑。WHERE 成立，Executor 找到了目标 Tuple。Heap 上却已经有两个版本：

```text
       Task 2 的旧版本               Task 2 的新版本

    +-------------------+         +-------------------+
    | running = false   |         | running = true    |
    | xmax = A          |         | xmin = A          |
    | t_ctid -----------+-------->|                   |
    +-------------------+         +-------------------+
             ^
             |
       B 扫描到的版本
```

B 想改旧版本，发现它已经被 A 更新，只能等 A 结束。A 回滚，B 还能改原来的版本；A 提交，B 就得面对新版本——任务已经启动，`NOT running` 不再成立。

之前讲行锁，关心的是谁持有锁、冲突时等谁。现在锁等待结束了，接下来怎么办，Lock Manager 管不了。

Heap 知道 Tuple 被谁更新，也知道后继版本在哪，但它不知道 Executor 当初为什么选中这个 Tuple。UPDATE 里还可能有表达式、Join、子查询，新值甚至要从旧字段算出来。这些都在执行计划里，Heap 只能把控制权交回 Executor。

## 把执行计划再跑一遍

Executor 通过 Table AM 改数据，普通 Heap 表最终会进入 `heap_update()`。Table AM 用 `TM_Result` 报告结果：

| 返回值       | 含义                        |
| ------------ | --------------------------- |
| `TM_Ok`      | 修改成功                    |
| `TM_Updated` | 目标 Tuple 已被其他事务更新 |
| `TM_Deleted` | 目标 Tuple 已被其他事务删除 |

READ COMMITTED 下，Executor 收到 `TM_Updated`，会去锁该行的最新版本，再用原来的条件复验。这套机制叫 EvalPlanQual，简称 EPQ。

普通 Heap UPDATE 的主要路径，省掉 Trigger、分区路由这些分支：

```text
ModifyTable
    |
    +-- table_tuple_update()
    |       |
    |       +-- heap_update()
    |               |
    |               +-- TM_Updated
    |
    +-- table_tuple_lock()
    |       |
    |       +-- 沿更新链锁住最新版本
    |
    +-- EvalPlanQual()
            |
            +-- 仍符合条件：重算更新结果
            |
            +-- 不再符合：跳过该行
```

调用 `table_tuple_lock()` 时带 `TUPLE_LOCK_FLAG_FIND_LAST_VERSION`，Table AM 会沿更新链找最新版本。

版本链不能只看 `t_ctid`。TID 是物理位置，旧版本被清理后，这个位置可能被别的记录复用。`heapam_tuple_lock()` 追踪时还要核对后一个版本的 `xmin` 是不是前一个版本的更新事务，免得把另一条记录当成后继。

拿到新 Tuple，事情还没完，复验才刚开始。对任务 2，再判一次 `NOT running` 好像就够了。可 SQL 一旦带 Join：

```sql
UPDATE task AS t
SET running = true
FROM resource_pool AS p
WHERE t.id = 2
  AND t.pool_id = p.id
  AND NOT t.running           -- 任务尚未启动
  AND p.enabled;              -- 资源池处于启用状态
```

任务行变了，要重判的不只是它自己的字段，还有连接条件；SET 里的值如果依赖 Join，也得重算。

PostgreSQL 没给 EPQ 另写 SQL 条件检查器，直接拿原来的子计划再跑一遍。

```text
普通执行                         EPQ 复验

    ModifyTable                    返回复验结果
         ^                              ^
         |                              |
    Filter / Join                  Filter / Join
      ^       ^                      ^       ^
      |       |                      |       |
    Scan    Scan                   Scan    Scan
      ^       ^                      ^       ^
      |       |                      |       |
    Heap    Heap                  最新的   原来参与
                                 目标行   Join 的行
```

EPQ 会另起一套 `EState` 和节点状态，但扫描节点的输入受到限制：它们要么使用指定的替代 Tuple，要么通过 RowMark 重新取原来参与 Join 的记录，不能自由扫描去找新候选。复验有输出就继续改，没有就跳过。

对 UPDATE，复验结果还能拿来构造待写入的 Tuple。多个事务同时执行：

```sql
UPDATE counter
SET value = value + 1
WHERE id = 1;
```

后来的事务等前一个提交后，能基于最新的 `value` 再加 1，而不是用等待之前算出的旧值。

普通执行不必为每个 Tuple 预建 EPQ 状态。子状态按需初始化，后面的复验还能接着用。

`EvalPlanQualStart()` 里有行代码：

```c
rcestate->es_snapshot = parentestate->es_snapshot;
```

EPQ 有自己的执行状态，Snapshot 却还是原语句的。它能把刚提交的新 Tuple 作为特殊输入交给计划，但整条查询没有因此换一份读视图。

## 任务没启动，池子却满了

把资源池恢复原状：容量为 2，任务 1 在跑，任务 2、3 没启动。

A 启动任务 3，顺手调整任务 2 的优先级：

```sql
-- Transaction A
BEGIN;

-- 启动任务 3，此处省略容量检查
UPDATE task
SET running = true
WHERE id = 3;

-- 调整任务 2 的优先级，但不启动它
UPDATE task
SET priority = priority + 1
WHERE id = 2;

-- 暂时不提交
```

B 启动任务 2，照旧检查状态和容量：

```sql
-- Transaction B
BEGIN;

UPDATE task
SET running = true
WHERE id = 2
  AND pool_id = 1
  AND NOT running           -- 任务 2 尚未启动
  AND (
      SELECT count(*)
      FROM task
      WHERE pool_id = 1
        AND running
  ) < 2;                    -- 资源池还有容量
```

两边都是 READ COMMITTED。A 没提交，B 看到任务 2 没运行，池里只有一个任务在跑，两个条件都成立。可 A 已经改过任务 2，B 还是得等。

A 提交后，已提交的数据变成这样：

```text
                    A 提交前        A 提交后
 ----------------------------------------------
 Task 1.running       true           true
 Task 2.running       false          false
 Task 2.priority        0              1
 Task 3.running       false          true

 运行任务数             1              2
```

B 进 EPQ，拿到任务 2 的最新版本。`priority` 变了，`running` 还是 `false`，`NOT running` 仍成立。池子却已经满了。容量检查怎么办？

`count(*)` 不依赖外层 Tuple，通常会被规划成 InitPlan，结果通过 `PARAM_EXEC` 交给主计划。EPQ 建子状态时，会沿用原 `EState` 里的参数值。所以容量检查很可能还在用之前算出的 `count(*) = 1`。

就算子查询重新扫，它仍然受原语句 Snapshot 约束，不会因为进了 EPQ 就看见 A 刚提交的全部修改。

B 的判断来自两个时间点：

```text
                     EPQ
                      |
           +----------+----------+
           |                     |
     最新目标 Tuple          原来的读取结果
           |                     |
     Task 2.running         count(*) = 1
         = false                 |
           |                     |
     NOT running            count(*) < 2
           |                     |
           +----------+----------+
                      |
                  条件成立
                      |
               启动 Task 2
```

目标行是最新的，容量计数是旧的。

在 PG19.0 上跑这组操作，B 返回 `UPDATE 1`。提交后查表：

```text
 id   running   priority
 -----------------------
  1     true        0
  2     true        1
  3     true        0
```

池子里有三个任务在跑。

READ COMMITTED 允许这种事。UPDATE 能看到别人对目标行的并发修改，却不一定能看到同一个事务对其他行的修改。

把 B 改成 REPEATABLE READ，结果就不同了。B 要维持事务级 Snapshot；目标行被别人更新并提交，新版本又不在自己的 Snapshot 里，PostgreSQL 不再允许这种版本切换。

```text
ERROR: could not serialize access due to concurrent update
```

SQLSTATE 是 `40001`，`serialization_failure`。没有 Savepoint 兜底的话，整个事务进入失败状态，只能回滚。应用重试要从头开始，让之前的读取和判断也重来。

REPEATABLE READ 挡住了这种新旧混用。但每笔事务都有稳定 Snapshot，不代表容量约束就安全。

## 各改各的行，结果一起越界

再恢复一次：任务 1 在跑，任务 2、3 没启动，容量 2。

A 启动任务 2，B 启动任务 3，两边都带容量检查，都用 REPEATABLE READ。

```text
Transaction A                  Transaction B
------------------------       ------------------------
尝试启动任务 2                 尝试启动任务 3

任务 2 尚未运行                任务 3 尚未运行
运行任务数 = 1                 运行任务数 = 1

两个条件均成立                 两个条件均成立

UPDATE 1                       UPDATE 1

COMMIT;                        COMMIT;
```

两边都在对方提交前完成读取和修改。改的不是同一行，不会撞行锁，Heap 正常写下两个新版本，EPQ 都不用进。

测试中两个事务都提交成功，最后三个任务都在跑。

换成串行：A 先，B 看到两个在跑，不启动 3；B 先，A 看到两个在跑，不启动 2。哪种顺序都只有两个。并发结果对不上任何串行顺序。

这叫写偏斜（Write Skew）。它不是丢失更新：两笔修改没互相覆盖，读到的数据也符合各自的 Snapshot，但写进去的组合破坏了业务约束。

PostgreSQL 的 REPEATABLE READ 实际是快照隔离（Snapshot Isolation，SI）。它给事务稳定的外部读视图，不保证并发结果等价于某个串行顺序。

要识别这种异常，光看单个 Tuple 的版本链不够，得看事务之间发生了什么。

## 事务之间的三条边

把事务画成点，依赖画成有向边。边的方向，就是等价串行顺序里的先后。

```text
wr：写读依赖
    A 写入 x，B 读取 A 写入的版本。

    A ----wr----> B


ww：写写依赖
    A 写入 x，B 再修改 A 产生的版本。

    A ----ww----> B


rw：读写反依赖
    A 读取 x 的旧状态，没有看到 B 对 x 的修改。

    A ----rw----> B
```

前两种直观：B 读或改了 A 产生的版本，串行顺序里 A 应该在 B 前面。

rw 是读写反依赖（rw-antidependency）。A 读的是 B 修改之前的状态，没看见 B 的写。要让 A 的读在串行执行中成立，A 得排在 B 前面。

这个先后和物理时间不完全一致。B 可能已经写了，只要写不在 A 的读视图里，A 仍然可以读到旧状态。

回到分别启动任务 2 和任务 3 的两个事务。A 统计时没看到 B 启动 3，B 统计时也没看到 A 启动 2。两条 rw 边成环：

```text
        A 没有看到 B 的修改
              rw
        A ----------> B
        ^             |
        |-------------+
              rw
        B 没有看到 A 的修改
```

A 必须排在 B 前面，B 又必须排在 A 前面。没有合法的串行顺序。

记录所有依赖、检测环，理论上就够了。可数据库里事务不断进进出出，维护完整依赖图再找环，成本很高。

## SSI 只盯危险结构

PostgreSQL 9.1 引入了可串行化快照隔离（Serializable Snapshot Isolation，SSI），用来实现 SERIALIZABLE。它利用 SI 的一个性质。

SI 下，wr 和 ww 的方向与提交顺序一致；并发事务之间的 rw 反依赖，则可能和提交顺序相反。进一步的理论结果说，任何序列化异常的依赖环里，都有两条相邻的 rw 边：

```text
          rw                   rw
 Tin -----------> Tpivot -----------> Tout
```

这叫危险结构（Dangerous Structure），`Tpivot` 同时有 rw 入边和出边。对真正的异常环，还能让 `Tout` 是环里最先提交的事务。

只有两个事务时，也能套这个形状：

```text
 A ----rw----> B ----rw----> A
 |                          |
 +------ 同一个事务 ---------+
```

有了这个性质，SSI 不用维护完整的 wr/ww/rw 图，只重点跟踪并发事务之间的 rw-conflict，再用提交顺序排除不可能成环的情况。

但危险结构只是必要条件，不是充分条件。两条相邻 rw 边可能只是更大依赖图里的一段，最后并没有成环。所以 SSI 会中止一些本来能安全提交的事务。省掉完整图和环检测，代价是可能多几次重试。

### rw-conflict 从哪里来

PostgreSQL 在共享内存里维护 `SERIALIZABLEXACT`，记录参与 SSI 的事务状态、提交顺序和冲突关系。这些依赖是在读写发生时一点点建起来的。

以 `A --rw--> B` 为例，按读写先后有两种发现方式：

```text
先写后读：

B 修改 x
    |
A 读取 x 的旧版本
    |
    +-- 利用已有 MVCC 信息发现 B


先读后写：

A 读取 x
    |
B 修改 x
    |
    +-- 检查 A 先前留下的读取记录
```

先写后读：B 改 x，A 读旧版本。Heap 做可见性判断时，能从 MVCC 信息里发现 B。

先读后写：A 先读 x，B 后改 x。Tuple Header 上没留下 A 读过它的痕迹，B 光看 `xmin`、`xmax`，不知道这次写会影响谁之前的读。

所以 PostgreSQL 得另外记住事务读过哪些范围。这就是 SIREAD Lock。

读路径通过 `CheckForSerializableConflictOut()` 发现从当前事务指向其他事务的 rw-conflict，也就是出边。写路径通过 `CheckForSerializableConflictIn()` 发现从其他事务指向当前事务的 rw-conflict，也就是入边。`FlagRWConflict()` 负责检查危险结构，并记录相应的依赖关系。

有些风险执行 SQL 时就能发现，有些要等提交顺序明确。事务提交前还有 `PreCommit_CheckForSerializationFailure()`。

把前面两个启动任务的事务都改成 SERIALIZABLE：

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
```

在 PG19.0 上，两个 UPDATE 都成功，后提交的那个在 COMMIT 时报错：

```sql
-- Transaction A
COMMIT;
-- COMMIT

-- Transaction B
COMMIT;
-- ERROR: could not serialize access due to
-- read/write dependencies among transactions
```

SQLSTATE 同样是 40001。最后只有两个任务在跑，容量守住了。

SSI 不是只在 COMMIT 检查。错误也可能出在 UPDATE 执行中，取决于依赖什么时候被发现、事务谁先提交。

## 没读到的行，也算读过

SIREAD 要记读取范围，具体记什么？还是容量检查：

```sql
SELECT count(*)
FROM task
WHERE pool_id = 1
  AND running;
```

假设只找到任务 1。若 SIREAD 只记任务 1 这条 Tuple，别人启动任务 2、任务 3 时，统计结果会变，却没碰任务 1。

更极端：池子里一个运行中的任务都没有，查询返回 `0`，一条符合条件的 Tuple 都没有。别人插入一条符合条件的记录，照样影响这次读取。

所以记录范围不能只覆盖返回给 Executor 的 Tuple，还得覆盖查询条件描述的那片数据。这就是谓词锁里的 Predicate。

直接存逻辑条件也行：`table = task`，`pool_id = 1 AND running = true`。以后每次改 task，都检查会不会改变这个谓词对应的集合。

可真实 SQL 的条件可能有表达式、函数、Join。逐个保存再让写入去匹配，读写路径就得额外维护一套谓词匹配机制。

PostgreSQL 换了个办法：借实际访问的数据结构，用物理范围近似逻辑范围。

### B-tree 知道范围

给任务表加一个部分索引：

```sql
CREATE INDEX task_running_idx
ON task (pool_id)
WHERE running;
```

这样，查某个池里正在运行的任务，就能在 B-tree 里搜 `pool_id`。

假设一个 Leaf Page 包含以下 Key：

```text
              B-tree Leaf Page P10

      +----------------------------+
 Key  |   1       2       3        |
      |   |       |       |        |
      |  TID     TID     TID       |
      +----------------------------+
          ^
          |
      搜索 pool_id = 1
```

事务 A 在 SERIALIZABLE 下搜 `pool_id = 1`，B-tree 会在访问到的索引页上记 SIREAD。PG19 里，页面读取在 `nbtreadpage.c`，调用 `PredicateLockPage()`。

假设 B 这时启动任务 2。`running` 从 `false` 变成 `true`，原本不在部分索引里的记录，现在要进索引。

```text
Task 2
running = false
      |
    UPDATE
      |
running = true
      |
      v
插入新的 Index Tuple
key = 1
      |
      v
B-tree Leaf Page P10
      |
      +-- 检查已有的 SIREAD
```

插入路径通过 `CheckForSerializableConflictIn()` 检查相关索引页面及更大范围上的谓词锁。A 的读和 B 的写就通过 P10 对上了，不用重跑 A 的查询条件。

就算 A 搜的 Key 当前不存在，B-tree 也知道它该落在哪个页面，照样能记 SIREAD。索引在组织数据的同时，也提供了表达读取范围的基础。

### 索引还是空的时候

如果 B-tree 连 Root Page 都没有，搜索会发现索引为空。没有具体页面可记，PostgreSQL 就给整个索引建 Relation-level SIREAD。

这里存在一个并发窗口：

```text
Transaction A                 Transaction B
------------------------      ------------------------
搜索索引，发现为空

                              插入第一条 Index Tuple
                              此时还没有 A 的 SIREAD

建立整个索引的 SIREAD
```

B 插入时，A 的 SIREAD 还没建好。A 要是直接结束扫描，两边都可能漏掉这次读写关系。

所以 `nbtsearch.c` 里，建完 Relation-level SIREAD 后，会再搜一次索引。第二次搜索不会让新数据变可见，查询还受原 Snapshot 约束。它的作用是：SIREAD 建立前的插入，由重扫的读路径通过 MVCC 发现；之后的插入，由写路径检查已有的 SIREAD。窗口就关上了。

### 页面分裂时，锁也得跟着分

之前讲 B-tree 页面分裂，关注的是页面结构变了，并发搜索还能不能找到数据。现在页面上还挂着另一种状态：别人读过这个页面代表的范围。

假设 A 已经在 P10 上建了 SIREAD，之后页面分裂：

```text
分裂前：

             P10
       +-------------+
       | 1  2  3  4  |
       +-------------+
           SIREAD A


分裂后：

       P10                 P11
   +-----------+       +-----------+
   |  1    2   |------>|  3    4   |
   +-----------+       +-----------+
     SIREAD A            SIREAD A
```

SIREAD 只留在 P10，后续插到 P11 的数据就可能绕过冲突检查。所以分裂路径会调用 `PredicateLockPageSplit()`，让新页面也覆盖原有的谓词锁。

分裂时两个页面还持有写锁，别人不会看到新结构却看不到 SIREAD。这里不用重新分析 A 的查询条件，也不用判断 A 真正关心哪半边；两边都保留，必要时再退化成更粗的覆盖。

删除空页面类似。原本属于这个页面的 Key 范围由右页承接，`PredicateLockPageCombine()` 会把谓词锁也交给右页。

哪怕触发分裂的事务自己没跑在 SERIALIZABLE，它也得维护别人留下的谓词锁。

## 提交之后，SIREAD 还得留一会儿

SIREAD 叫 Lock，和普通行锁却不像。行锁记谁有访问权限，冲突时可能要等；SIREAD 记已经发生的读，用来找依赖。它不挡别人写，而且可能在持有者提交后继续存在。

看两个 SERIALIZABLE 事务：

```text
时间 ---------------------------------------------->

A   [ 读取 x ------------ COMMIT ]
        |                          |
        |                          |
B       [ 获取 Snapshot ----------- 修改 x --- COMMIT ]
```

B 在 A 提交前就拿了 Snapshot。B 改 x 时，A 虽然已经提交，两者之间仍有 rw 关系，可能和别的依赖组成危险结构。A 提交时就把 SIREAD 和事务状态清光，B 后面写时就找不到这段读历史。

在 PG19.0 上验证过。A 读 `task`，同时改另一张测试表 `marker`，确保 A 确实写过东西。B 在 A 提交前拿 Snapshot，保持事务开着。第三个 Backend 查 `pg_locks`：

```text
                         task         marker
------------------------------------------------
A 提交后，B 仍然活跃      SIReadLock   SIReadLock
B 回滚后                 无           无
```

整个过程没跑 VACUUM，也没等后台维护进程。B 一结束，先前保留的谓词锁就没了。

不过这是独立实例。如果还有别的活跃 SERIALIZABLE 事务，清理可能更晚。

### 清理边界怎么算

PostgreSQL 不会给每个已提交事务维护一份完整的重叠事务名单，再等名单里的事务逐个结束。它用了个类似 MVCC 回收边界的办法。

每个参与 SSI 的事务都有自己的 `xmin`，来自它的 Snapshot。全局维护 `SxactGlobalXmin`，表示仍在 SSI 跟踪的活跃事务里最老的 Snapshot xmin。

事务结束时，`ReleasePredicateLocks()` 读当时的 `nextXid`，记进 `finishedBefore`，标记这个事务结束时的事务号边界。成功提交的事务进入 `FinishedSerializableTransactions` 链表，等后续清理。

假设 SSI 里保存了这些状态：

```text
仍然活跃的 SSI 事务

    T1: xmin = 100
    T2: xmin = 120
    T3: xmin = 135

    SxactGlobalXmin = 100


已经提交的 SSI 事务

    A: finishedBefore = 90
    B: finishedBefore = 110
    C: finishedBefore = 130
```

`ClearOldPredicateLocks()` 检查已提交事务的 `finishedBefore` 是否满足完整清理条件。忽略事务号回卷，用普通数字：

```text
完整清理条件：

finishedBefore <= SxactGlobalXmin


当前 SxactGlobalXmin = 100

A:  90 <= 100    可以完整清理
B: 110 >  100    尚未满足完整清理条件
C: 130 >  100    尚未满足完整清理条件
```

`A` 的 `finishedBefore` 是 90，现有活跃事务的 Snapshot 已经不需要考虑它那段并发历史，可以清。`B`、`C` 还不行。

最老的 T1 结束后，如果没有别人还持有相同的 `xmin`，`SetNewSxactGlobalXmin()` 会重算下界：

```text
SxactGlobalXmin

     100 ----------> 120 ----------> 135
      |               |               |
   A 可清理         B 可清理         C 可清理
```

达到完整清理条件后，PostgreSQL 释放 SIREAD、剩余的冲突关系和 `SERIALIZABLEXACT` 本身。没有需要跟踪的活跃事务，历史状态也不用留。

这个边界是保守的。事务实际上不会再产生新冲突，不代表 SIREAD 马上消失。

这套生命周期归 SSI 自己管，不等 VACUUM，也不靠原 Backend 活着。一个长 SERIALIZABLE 事务除了可能拖 Heap 旧版本回收，也可能让 SSI 多留一段已提交历史。

### SIREAD 可以提前释放

完整清理要等事务状态一起回收。只考虑 SIREAD 的话，还有空间。

```text
时间 ------------------------------------------------>

A   [ 读写事务 ------ COMMIT ]

B       [ 读写事务 ------- COMMIT ]

C       [ 只读事务 -------------------------- COMMIT ]
                               ^
                               |
                      已经没有活跃的读写事务
```

虽然 C 的 Snapshot 更老，但它只读，不会再写，也就不会通过写和 A、B 留下的 SIREAD 建新冲突。后来进入的事务也不再和 A、B 重叠。A、B 的谓词锁继续留着没意义。

PostgreSQL 维护 `WritableSxactCount`，统计还在 SSI 跟踪、且没声明只读的事务数。计数降到 0，就把 `CanPartialClearThrough` 推到当前最新的 SSI 提交序号。

之后 `ClearOldPredicateLocks()` 对提交序号落在这个边界内的读写事务，即使没满足完整清理条件，也能部分清理：

```text
一个已经提交的读写事务

+-----------------------------------+
| SERIALIZABLEXACT                  |  保留
|                                   |
| SIREAD Locks                      |  释放
|                                   |
| rw-conflict in   (其他事务 -> 自己) |  释放
|                                   |
| rw-conflict out  (自己 -> 其他事务) |  保留必要信息
+-----------------------------------+
```

为什么出边还要保留？仍然活跃的只读事务 C，可能在后续读取中读到 A 修改之前的旧版本。A 在 C 拿到 Snapshot 之后提交，它的写入不在 C 的 Snapshot 里，这就形成一条新的 `C --rw--> A`。如果 A 之前还留下一条指向 D 的 rw-conflict，两条边就会接上：

```text
       新发现的依赖        已有的历史依赖

C --------rw-------> A --------rw-------> D
```

对于只读事务，这个结构只有在 D 在 C 获取 Snapshot 之前提交时，才可能构成真正的序列化异常。判断这一条件，仍然需要 A 保存的出边及相关提交顺序信息。

所以 A 的 SIREAD 已经可以释放，A 的事务依赖状态却还需要保留。`ReleaseOneSerializableXact()` 的部分清理对应的就是这一取舍：释放谓词锁和入边，留下事务状态和必要的出边。

这样，谓词锁的生命周期和事务依赖状态分开，可以尽早释放不再需要的共享内存。

### 回滚、只读，各有各的出路

顶层事务回滚简单。它不会出现在最终成功提交的历史里，SIREAD 和 SSI 状态可以直接清。

子事务回滚不能照办。子事务读过的数据可能还影响外层事务后面的执行，不能因为回滚到 Savepoint 就丢掉这段读历史。

普通只读事务有个额外优化。它不写数据，但读结果仍可能受其他并发事务依赖关系的影响，所以 SERIALIZABLE READ ONLY 不等于不用 SSI。

如果能确认一份 Snapshot 不可能参与序列化异常，它就是安全快照（Safe Snapshot）。只读事务拿到安全快照，或运行中被确认安全，就不用继续做 SSI 冲突检测，已有谓词锁也能提前放。

PostgreSQL 还提供了事务选项：

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE;
```

这样的事务第一次拿 Snapshot 时可以等并发事务结束。候选不安全就重拿，直到安全再开始查询。

对运行时间较长的报表查询，这是一种很实用的选择：把可能的等待集中到获取 Snapshot 时，后续查询不再承担常规的 SSI 跟踪成本，也不会因为 SSI 冲突而发生序列化失败。

## 同一个查询，两种计划，两种锁范围

回到部分索引。A 只想统计池 1 里正在运行的任务：

```sql
SELECT count(*)
FROM task
WHERE pool_id = 1
  AND running;
```

B-tree 上的 SIREAD 却覆盖整个索引页：

```text
              Page P10

     +----------------------------+
     | pool 1 | pool 2 | pool 3  |
     +----------------------------+
         ^
         |
     A 关心的 Key

     |<-------------------------->|
            SIREAD 覆盖范围
```

如果 B 启动的是池 2 的任务，新 Index Tuple 恰好落进同一页，PostgreSQL 也可能保守地记一条 rw-conflict。两个池业务上无关，物理上共享了读取范围。

一条额外 rw-conflict 不会直接回滚，还要看其他依赖和提交顺序。但它增加了形成危险结构的可能。

如果换成 Seq Scan，范围更大。可以在 SERIALIZABLE 事务里直接看：

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;

-- 实际执行容量检查
SELECT count(*)
FROM task
WHERE pool_id = 1 AND running;

-- 查看当前 Backend 的谓词锁
SELECT
    locktype,
    relation::regclass,
    page,
    tuple,
    mode
FROM pg_locks
WHERE mode = 'SIReadLock'
  AND pid = pg_backend_pid();

ROLLBACK;
```

在 PG19.0 上分别让查询走 Seq Scan 和 B-tree Index Scan：

**Seq Scan**

```text
Aggregate
  -> Seq Scan on task
```

对应的谓词锁：

```text
 locktype   relation   page   tuple   mode
 -----------------------------------------------
 relation   task        -       -     SIReadLock
```

**Index Scan**

```text
Aggregate
  -> Index Scan using task_running_idx on task
```

对应的谓词锁：

```text
 locktype   relation           page   tuple   mode
 -------------------------------------------------------
 page       task_running_idx     1      -     SIReadLock
 tuple      task                 0      29    SIReadLock
```

页号和 Tuple Offset 取决于数据布局，重点在粒度。

Seq Scan 在整个 Heap Relation 上建谓词锁，这样后续修改或插入即使发生在此前没匹配记录的位置，也能参与检测。Index Scan 分别记索引页和实际访问的 Heap Tuple，范围通常更局部。

对不能自己维护谓词锁的 Index AM，PostgreSQL 会退化到整个索引的 Relation-level SIREAD。访问方法的能力，也会影响 SSI 的检测精度。

平时聊 Seq Scan 和 Index Scan，关心扫多少页、读多少 Tuple、做几次随机 I/O。到了 SERIALIZABLE，访问路径还决定事务留下什么读取记录、后面写入会和谁建冲突。

两个计划结果一样、单次耗时也接近，高并发下的事务重试成本可能不同。

### 锁太多就提升，历史太长就摘要

读取范围记得越细，谓词锁越多。谓词锁要在共享内存里存锁对象和事务关联，和行锁不一样。一个 SERIALIZABLE 事务可能读很多数据，每次读都建细粒度 SIREAD，谓词锁表很快会成为瓶颈。

PostgreSQL 因此有粒度提升（Promotion）：

```text
Tuple-level                    Page-level

SIREAD (10, 1)
SIREAD (10, 2)       ------>    SIREAD (10)
SIREAD (10, 3)


Page-level                     Relation-level

SIREAD (10)
SIREAD (11)          ------>    SIREAD (task)
SIREAD (12)
```

同一 Page 上 Tuple-level SIREAD 太多，就用一个 Page-level 覆盖，释放细粒度锁；Relation 层也能类似提升。

相关参数有三个：

- `max_pred_locks_per_transaction`：参与决定共享谓词锁表的容量。
- `max_pred_locks_per_page`：控制 Tuple-level 锁向 Page-level 提升的阈值。
- `max_pred_locks_per_relation`：控制细粒度锁向 Relation-level 提升的阈值。

`max_pred_locks_per_transaction` 不是每个事务独立的硬上限，整个系统用的是共享资源池。

谓词锁少了，不代表 SSI 事务状态不积累。一个长事务可能和很多已提交短事务重叠，系统得保留越来越多的并发历史。

保存 `SERIALIZABLEXACT` 的空间不够时，PostgreSQL 会对较老的已提交事务做摘要化（Summarization）。

```text
摘要化前：

Committed Transaction A
    +-- SIREAD P10
    +-- SIREAD P11
    +-- 事务依赖信息

Committed Transaction B
    +-- SIREAD P10
    +-- 事务依赖信息


摘要化后：

OldCommittedSxact
    +-- SIREAD P10
    +-- SIREAD P11

Serial SLRU
    +-- 必要的历史事务摘要
```

把旧事务的谓词锁转到公共的 `OldCommittedSxact` 下，合并重复的读取范围，再用 SLRU 保存后续冲突检测还需要的事务摘要。这样不必为每个历史事务保留完整的共享内存对象和依赖关系。

粒度提升压的是读取范围的表达，摘要化压的是长期并发历史。

这两种优化，加上分裂时复制谓词锁、空索引时锁整个索引，都依赖同一个取舍：**冲突检测可以保守，但不能漏。** PostgreSQL 用有限的共享内存管大量读取记录和事务历史，代价是检测可能不够精确。

## 回到那条 UPDATE

开头那条 SQL，其实包含两个尺度的判断：

```sql
UPDATE task
SET running = true
WHERE id = 2
  AND pool_id = 1
  AND NOT running           -- 目标任务的状态
  AND (
      SELECT count(*)
      FROM task
      WHERE pool_id = 1
        AND running
  ) < 2;                    -- 整个资源池的状态
```

目标行被其他事务修改时，READ COMMITTED 能用 EPQ 拿新版本，用原计划重判条件。

但容量限制跨多个 Tuple。每次修改都基于合法版本，几笔事务的组合仍可能不对应任何串行顺序。

SSI 处理的就是事务之间的依赖。Heap 的版本信息用来发现先前的写，B-tree 的物理组织用来表达读取范围，谓词锁的粒度和生命周期让数据库在有限共享内存里保留必要历史。

当然，真实调度系统未必需要 SERIALIZABLE。可以在 READ COMMITTED 下先锁资源池记录：

```sql
BEGIN;

-- 先锁住资源池，协调同一资源池内的任务启动
SELECT id
FROM resource_pool
WHERE id = 1
FOR UPDATE;

-- 取得锁之后，再检查容量并启动任务
UPDATE task
SET running = true
WHERE id = 2
  AND pool_id = 1
  AND NOT running
  AND (
      SELECT count(*)
      FROM task
      WHERE pool_id = 1
        AND running
  ) < 2;

COMMIT;
```

如果所有会改变该池运行任务数的事务都遵守同一套加锁协议，第二条语句就能在拿到池锁后，用新的语句级 Snapshot 做容量检查。

也可以把运行任务数维护在池记录上，把跨 Tuple 的约束变成单行更新冲突。

这些方案更有针对性，成本可能更低，但应用要自己维护并发协议，也得承受热点行等待。

SERIALIZABLE 是另一种选择：只要相关事务串行执行时能守住业务约束，并且都用了这个隔离级别，应用就可以把检测交给数据库，收到序列化错误时重试整个事务。

对任务调度系统，容量限制很明确，集中加锁或维护计数可能更合适。可当一个事务的写入依赖越来越多读取结果，业务约束越来越复杂，逐个设计加锁协议的成本就会上去。这时候，SSI 的通用性才有价值。
