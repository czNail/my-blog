---
author: Neil Chen
pubDatetime: 2026-10-10T00:00:00+08:00
title: B-tree 的并发搜索与页面分裂
description: 一个 Backend 拿着过期的 Downlink 走进旧 Page，另一个刚好完成了 Split。High Key、Rightlink 以及 Incomplete Split，如何让这次并发搜索继续找到正确的 Key。
tags:
  - postgresql
  - internals
---

# B-tree 的并发搜索与页面分裂

一个 Backend 正在 B-tree 索引里查找 Key 70。

它顺着索引树往下走，从 Parent Page 拿到一条指向 Block 42 的 Downlink——也就是父页里指向子页的那条指针。接下来只要进入 Block 42，继续查找就行了。

偏偏就在这时，另一个 Backend 往同一张索引里插入了新记录。Block 42 空间不够，发生了 Page Split，一部分记录被搬到了新分配的 Block 73。

```text
Backend A sees:

  Parent
     |
     v
  Block 42
  +--------------------+
  | 10  20  30  60  70 |
  +--------------------+


Backend B after split:

  Parent
  /    \
 v      v
 Block 42              Block 73
 +----------------+    +----------------+
 | 10   20   30   |--->| 60   70        |
 +----------------+    +----------------+
```

等 Backend A 真正进入 Block 42，Key 70 已经不在这里了。

Parent 里可能已经补上了指向 Block 73 的新 Downlink，但 A 是在 Split 之前读到的旧地址。它也没必要为此回到 Root，把整棵树重新搜一遍。

这样的并发时序在 PostgreSQL 中完全可能出现，原因也很直接：搜索不会一直锁住从 Root 到 Leaf 的整条路径。Backend 从 Parent 选出 Downlink 之后，就可以释放 Parent Lock，再去获取 Child Lock；在这段间隙里，别的 Backend 完全可能修改 Child，甚至把它一分为二。

对此，PostgreSQL 留了一条修正路径。即使沿着过期的 Downlink 落到了旧 Page，搜索仍然能找到已经移到右侧的新位置。

关键就是 B-tree Page 里的 High Key 和 Rightlink。

## 旧 Downlink 仍然能找到路

PostgreSQL 的 B-tree 实现基于 Lehman-Yao 高并发 B-tree 算法，High Key 和 Rightlink 是它处理并发 Split 的两个基础。

还是刚才的 Block 42。

为了方便，这里用整数表示索引 Key，先不管 Heap TID（记录在堆表里的物理位置）和其他排序细节。

```text
  Parent
     |
     v
  Block 42              Block 73
  +----------------+    +----------------+
  | High Key = 60  |    | Rightmost      |
  +----------------+    +----------------+
  | 10   20   30   |--->| 60   70        |
  +----------------+    +----------------+
  | Rightlink = 73 |    | Rightlink NONE |
  +----------------+    +----------------+
```

原来的 Block 42 留在左边，Block Number 不变；右半部分记录被搬到新分配的 Block 73。Block 42 上的 High Key 划定了本页 Key Range 的上界，Rightlink 则指向同层的右兄弟。

Backend A 沿旧 Downlink 到达 Block 42 后，第一件事是检查目标 Key 有没有超出这个 Page 的范围。

要找的是 70，当前 High Key 是 60，于是沿 Rightlink 进入 Block 73。

万一 Block 73 又被别人分裂了呢？再检查新 Page 的 High Key，不合适就继续往右走。

`_bt_moveright()` 做的就是这件事。

这里有个前提：**Split 之后，原来的 Page 始终留在左侧。**

原来的 Downlink 指向 Block 42。无论 Block 42 后来被分裂多少次，原本在它上面的记录要么留在原 Page，要么移到它右边。于是一条过期的 Downlink 最多把搜索带到目标 Key Range 左侧的某个 Page，只要沿着 Rightlink 向右追，就还有机会找到正确位置。

反过来，如果原来的 Block 在 Split 后可能变成右半部分，搜索就可能一步跨过目标范围，那时光靠 Rightlink 显然不够。

这个约束直接决定了 PostgreSQL B-tree Split 的基本形态。

### High Key 放在哪里

High Key 和 Rightlink 的物理位置并不一样。

Rightlink 位于 B-tree Page 的 Special Space（页尾存放页级元数据的区域），对应 `BTPageOpaqueData` 里的 `btpo_next`。这个结构还存着 `btpo_prev`、`btpo_level` 和若干 Page Flag：`btpo_prev` 指向左兄弟，主要用于反向扫描；`btpo_level` 表示 Page 所在层级，Leaf Page 的 level 是 0。

High Key 占用的则是 Page Item Array（页内的行指针数组）的第一个位置。数组里存的是 ItemId 指针，指针 1 指向的那条 Pivot Tuple 才是 High Key；它的字节和普通 Index Tuple 一样，存放在后面的 Tuple Data 区域。

一个非 Rightmost Page 大致长这样：

```text
+----------------------------------+
| Page Header                      |
+----------------------------------+
| ItemId 1 ---> High Key           |
| ItemId 2 ---> Index Tuple        |
| ItemId 3 ---> Index Tuple        |
| ItemId 4 ---> Index Tuple        |
+----------------------------------+
| Free Space                       |
+----------------------------------+
| Tuple Data                       |
|   High Key / Index Tuples        |
+----------------------------------+
| Special Space                    |
|   BTPageOpaqueData               |
+----------------------------------+
```

Rightmost Page 没有物理 High Key，上界相当于正无穷，所以第一个 Item 就是普通数据。

High Key 也未必等于本页最大的用户 Key。

High Key 通常取自右兄弟的第一个 Key，只负责把相邻两页的 Key Range 分开，不必等于某条真实存在的索引键。这类用来划边界的索引项，在 PostgreSQL 里叫 Pivot Tuple。

它是可以压缩的。举个多列索引 (a, b, c) 的例子：左页最后一个 Key 是 (1, 2, 9)，右页第一个 Key 是 (1, 3, 0)。第二列的 3 已经大于 2，High Key 写成 (1, 3) 就足以把两边的 Key 分开，后面的 c 列根本不用存。这种只保留到能区分的那一列为止的压缩，就叫 Suffix Truncation。

再加上排序时 Heap TID 作为 Tie-breaker，用户 Key 相同的记录也有确定的物理先后。所以 High Key 的比较要遵守完整的 B-tree 排序规则，不是拿两个整数比大小那么简单。

这些细节和重复 Key 的处理关系很大，但眼下只需要记住：High Key 给 Page 划定导航边界，Rightlink 把相邻的 Key Range 串起来。

## 每下降一层，都要重新确认位置

回到 `_bt_search()`。

它从 Root 开始，用 `_bt_binsrch()` 在 Internal Page 里选出合适的 Downlink，然后释放当前 Page Lock，进入下一层。落到新 Page 上后，先调用 `_bt_moveright()`。这一步可能沿 Rightlink 移动一个甚至多个 Page，直到找到合适的 Key Range。

为什么只在 Leaf Page 上检查还不够？

因为 Internal Page 同样会 Split。Backend 从 Root 走向某个 Internal Page 的途中，目标可能已经被另一个 Backend 分裂了。即使还没到 Leaf，也要根据当前 Page 的 High Key 修正位置。

`_bt_moveright()` 负责这一层的导航修正，`_bt_binsrch()` 负责在选定的 Page 内做二分定位。代码里的循环大致是：

```text
        Root
          |
          v
+---------------+
| Current Page  |<-----------+
+---------------+            |
          |                  |
_bt_moveright()              |
          |                  |
    +-----+-----+            |
    |           |            |
  Leaf?      Internal        |
    |           |            |
   Yes      _bt_binsrch()    |
    |           |            |
    v       pick Downlink    |
  return        |            |
                v            |
         release Parent      |
         get Child Lock      |
                |            |
                +------------+
```

这里还有个容易忽略的边界。

`_bt_moveright()` 依据目标 Key 和 High Key 的比较结果决定要不要右移，但相等时，两种搜索模式的处理并不一样：

- 普通模式 `>= key`：找第一个大于等于 key 的位置；
- `nextkey` 模式 `> key`：找第一个严格大于 key 的位置。

| 搜索模式 | `key < HK` | `key == HK` | `key > HK` |
| --- | --- | --- | --- |
| 普通 `>= key` | 留在本页 | 留在本页 | 右移 |
| `nextkey` `> key` | 留在本页 | 右移 | 右移 |

差别只在 `key == HK` 这一格，根源是 High Key 有可能和本页最后一个 Item 相等（重复 Key 跨页时就会出现）。比如 High Key 和本页最后一个 Item 都是 60：`>= 60` 时本页这个 60 就是命中项，不能跳过；`> 60` 时本页已经到顶，只能去右页。

这里的比较遵循完整的 B-tree 排序语义，包含 Heap TID 等 Tie-breaker，并不只是比较用户列的值。

ScanKey（这次搜索的键和比较方式）的构造和预处理这里不展开。就并发 Split 而言，更关键的是 `_bt_moveright()` 在每一层都会执行。

Root Split 也一样。

PostgreSQL 允许 Backend 使用稍微过期的 Root 或 Fast Root 信息。Fast Root 是 B-tree 为了减少不必要的层级访问而维护的搜索入口：当上层存在多个只有一个 Page 的层级时，搜索可以直接从更低的 Fast Root 开始，跳过它们。Root 信息也可能被 Backend 缓存，所以搜索要能处理入口已经过期的情况。

旧 Root 在 Split 后保留原 Block Number，并通过 Rightlink 连到新产生的兄弟 Page。即使另一个 Backend 已经建好了更高层的新 Root，先前开始的搜索仍然可以沿旧 Root 所在层级的 Rightlink 修正位置。

所以树高变了，也不一定需要让所有正在执行的搜索回到 Root 重来。

有了 High Key 和 Rightlink，搜索能容忍上层导航信息短暂落后。写路径则要为此多做些安排。

## Split 先把兄弟 Page 接好

一次普通的 B-tree Insert 会先定位目标 Leaf Page。空间够，就直接插入 Index Tuple。

空间不够时，PostgreSQL 还会尝试删除无用的索引记录，或者通过 Deduplication（把重复 Key 合并存储）腾空间。这些和 MVCC 产生的旧版本、索引膨胀有关，留到下一篇说。

都不够用了，才轮到 `_bt_split()`。

假设同一层原本有两个 Page，现在 A 需要 Split。PostgreSQL 先选 Split Point，再准备左右两个 Page 的内容。Split Point 不是简单地把记录数对半分，还要考虑即将插入的新 Item 和页面空间利用率。

```text
Before split:

  Parent
     |
     v
  A -----------------> B


After split:

  Parent
     |
     v
  A -------> R --------> B

  A: New High Key / Rightlink = R
  R: New Right Page / R.prev = A / R.next = B
  B: B.prev = R
```

A 保留原 Block Number，存放左半部分；R 是新分配的 Right Page。

如果原来存在 B，B 的 Leftlink 也要从 A 改成 R。

这些改动必须协调完成。否则可能出现 A 的 Rightlink 已经指向 R、R 却没准备好，或者原 Right Sibling 的链接还没更新的中途状态。

`_bt_split()` 会把 Split Point 计算、临时 Page 构造和必要的锁获取尽量放到真正修改之前；进入 Critical Section（临界区）后，才去更新 Left Page（也就是原来的 A）、新 Right Page 和相关 Sibling Link（同层相邻页之间的左右链接），设置 Dirty 并生成 WAL。

这里用的 WAL Record 是 `XLOG_BTREE_SPLIT_L` 或 `XLOG_BTREE_SPLIT_R`，区别在于新插入的 Item 最终落在左半还是右半。

一条 Split Record 可以涉及多个 Page。Left Page 的 High Key、新 Right Page 的内容，以及必要的 Sibling Link 更新，都是这一层需要原子完成的结构修改。

如果 Split 发生在 Internal Page，还可能顺手完成下一层尚未结束的 Parent Insertion（把新页的 Downlink 补插到父页，下一节马上讲），并清掉对应 Child 的 Incomplete Split（子页已经分裂、父页却还没补上 Downlink）标记。

前面讲 WAL 时已经见过这种多 Page Record。放到 B-tree Split 里，它的目的很明确：恢复出来的这一层必须有正确的 Key Range 和 Sibling Link。

不过到这一步，新产生的 Right Page 还没有自己的 Parent Downlink，得靠 `_bt_insert_parent()` 更新上一层。

为什么不把 Parent Insertion 一起塞进同一个原子操作？

因为 Parent 自己也可能是满的。

Leaf Split 要往 Parent 插一条新 Downlink，Parent 满了又要 Split，接着可能牵连 Grandparent，一路向上直到建出新 Root。这是一条长度不固定的修改链，要一次做完，锁的持有范围和 WAL 组织都会变得很麻烦。

所以 PostgreSQL 先完成当前层的 Split，让同层页面能被正确搜索，再向 Parent 插 Downlink；Parent 满了就重复这个过程。

于是，子层已经 Split、Parent 还没更新，就成了一种必须正视的中间状态。

## Parent 还欠一条 Downlink

假设 A 已经分裂成 A 和 R，但 Parent 里仍然只有指向 A 的那条 Downlink。

Reader 可以顺着 A 的 Rightlink 找到 R，搜索这条路已经够用。

Writer 的处境要多一些。

如果 R 接下来还要 Split，插入算法得先找到 R 在 Parent 里的位置，再把新产生的 Downlink 插进去。可 Parent 里连 R 的 Downlink 都没有，继续改结构就可能出问题。

PostgreSQL 用 `BTP_INCOMPLETE_SPLIT` 来记录这种状态。这个 Flag 打在 Left Page 上，表示它的右兄弟还没有 Parent Downlink。

```text
  Parent
     |
     v
  +------------+     +------------+
  |     A      |---->|     R      |
  |------------|     |------------|
  | High Key   |     |  New Key   |
  | INCOMPLETE |     |   Range    |
  +------------+     +------------+
                            ^
                            |
                   R has no Parent Downlink
```

缺 Downlink 的明明是 R，标记为什么在 A 上？因为搜索总是从 A 沿 Rightlink 走过来，一看到这个标记，就知道后面还有一项没完成的 Parent Insertion。

正常情况下，执行 Split 的 Backend 会继续调用 `_bt_insert_parent()`：从 A 的 High Key 构造 Parent 用的 Pivot Tuple，把 Downlink 指向 R 的 Block Number，然后插进 Parent。

Parent 有空位时，插入和清除 A 的 `BTP_INCOMPLETE_SPLIT` 可以由同一个 `XLOG_BTREE_INSERT_UPPER` 动作完成。

Parent 也满了，就触发 Parent Split，在对应的结构动作里一并处理 Child 的 Incomplete Flag。

Root Split 则要新建 Root、更新 Metapage（B-tree 的元数据页），由 `XLOG_BTREE_NEWROOT` 记录。

无论走哪条分支，建立 Parent Downlink 和清除 Child Incomplete Flag 都必须绑在一起。否则可能出现 Parent 还缺 Downlink、A 却不再标记 Incomplete 的情况，后来者就失去了发现这项未完成工作的线索。

正常执行期间，相关 Child Page 会一直持有必要的 Write Lock，直到 Parent Insertion 完成，这也顺便避免了两个 Writer 同时发现同一个 Incomplete Split、各自去修一遍。

所以在 Primary 上，Reader 通常不会撞见一个正被原 Writer 处理中的 Incomplete Split。

但开头的 Backend A 仍可能遇到过期的 Downlink：它在 Split 开始前就离开了 Parent，等拿到 Child Lock，整个 Split 可能早已结束。

这是两回事。

### 原来的 Writer 没能做完

假设 `_bt_split()` 已经完成，新的 Right Page 建好了，本层修改也写进了 WAL。

接着准备向 Parent 插 Downlink 时，操作因为内存不足、磁盘空间不足之类的原因失败了。

PostgreSQL 不会随事务 Abort 把已经完成的 B-tree 结构 Split 反向撤销。

A 和 R 还在，`BTP_INCOMPLETE_SPLIT` 也留在 A 上。

下一个 Writer 经过这里时，可以通过 `_bt_finish_split()` 把缺的 Parent Downlink 补上。

```text
First write:

Split A -> A + R
      |
      v
split done at this level
      |
      v
Parent Insertion
      |
      X  ERROR


State left behind:

A(INCOMPLETE) -----> R


Later writer:

sees A(INCOMPLETE)
      |
      v
_bt_finish_split()
      |
      v
fill in Parent Downlink
clear Incomplete Flag
```

修复时还有一件事要考虑：原来保存的搜索路径可能已经过期。

B-tree 插入时可以用 `BTStack`（记录下降路径的栈）记下途中经过的 Parent Block 和 Offset。但在这段时间里，Parent 自己也可能 Split，原来的 Offset 未必还指着正确的 Pivot Tuple。

所以 `_bt_insert_parent()` 要通过 `_bt_getstackbuf()` 重新定位 Parent，必要时沿同层 Rightlink 继续找。

Reader 没这些负担。它只需要找到目标 Key Range，沿 Rightlink 走下去就行；Writer 则可能马上要改结构，必须先补齐相关的 Downlink。

把修复交给 Writer，也有现实考虑。

如果普通查询负责修复，原本只读的操作就可能要修改 Parent、写 WAL，甚至在 Parent 满时分配新 Page。Hot Standby 上根本没法做这种更新。

VACUUM 通常也不会主动去补 Leaf 的 Incomplete Split。补 Parent Downlink 可能触发新的 Page Split、需要更多磁盘空间，而 VACUUM 往往正是在空间紧张时被叫起来的。只有某些涉及页面删除的路径，才会顺带处理一下。

于是一次失败的 Parent Insertion，不会逼着之后每个访问者都参与修复。Reader 照常查询，等后面有 Writer 需要继续改结构时再把它做完。

## Crash 恰好发生在两个阶段之间

前面说的是执行错误，Crash 也会留下同样的局面。

假设一次 Split 的 WAL 已经持久化，但 Parent Insertion 对应的 WAL 还没来得及写。

```text
WAL
   |
   v
+-----------------------------+
| XLOG_BTREE_SPLIT_R          |
|   A's High Key              |
|   A -> R -> B               |
|   INCOMPLETE_SPLIT          |
+-----------------------------+
   |
   v
WAL durable
   |
   X  CRASH
   |
   X  Parent Insertion
      (WAL never written)
```

Recovery 会通过 `btree_redo()` 找到对应的 Split Redo Routine。

新 Right Page 可以重新初始化，再按 WAL 里的内容重建。Left Page 恢复新的 High Key 和 Rightlink；如果存在原 Right Sibling，也要恢复它的 Leftlink。

最后得到的可能就是一棵带着 Incomplete Split 的 B-tree：Parent 没有指向 R 的 Downlink，但 R 已经通过 A 的 Rightlink 挂在同一层的 Page 链上。

Reader 仍然能正常搜索。

Redo 不会重新执行 `_bt_insert_parent()`。Parent Insertion 涉及重新定位 Parent、判断页面空间，还可能继续触发上层 Split，这些都是前台写入算法的工作。恢复阶段只按照已有的 WAL Record 重建页面状态。

WAL 里已经有 Parent Insertion Record，Redo 就继续恢复 Parent Downlink 并清除对应的 Incomplete Flag；没有的话，这件事就留给后续 Writer。

这种做法还有一段历史。

PostgreSQL 9.4 之前，Recovery 会自己跟踪没做完的 B-tree Split，并在恢复结束时统一补齐；后来改成了按需修复。

集中到 Recovery 结束处理，要多维护一份状态，还得让恢复过程参与复杂的 B-tree 结构修改。而且 Incomplete Split 不一定来自 Crash——前面说的内存不足、磁盘不足等普通错误，同样可能卡在两个结构动作之间。既然 Page 自己已经存了 Incomplete Split Flag，让后续 Writer 按需修复，就能一次覆盖这些场景。

Hot Standby 又给 WAL 的原子性加了一条实际约束。

Standby 可能一边应用 WAL，一边跑只读查询。Split Record 已经 Redo、Parent Insertion Record 还没 Redo 时，查询仍然要能找到正确的 Key Range。

所以 Split 的 WAL 原子动作必须留下一个 Reader 能正确搜索的同层结构。Redo 会协调同层 Sibling Link 的更新，但不需要完整复现 Primary 上为多个 Writer 互斥而设置的 Parent-Child 锁关系——Standby 这里没有 Writer 抢 Parent Insertion，Reader 靠 High Key 和 Rightlink 就能继续导航。

## 一条旧 Downlink 的代价

现在再看开头的 Backend A。

它从 Parent 读到 Block 42，等真正拿到 Block 42 的锁时，这个 Page 已经被别人分裂过。但 Block 42 仍然是那一层的有效入口：A 检查 High Key，发现 Key 70 已经在右边，于是沿 Rightlink 找到 Block 73。

整个过程不用回 Root 重搜。

Page Split 本身也可以分阶段做：先把同层结构接好，再往上补 Parent Downlink。中间要是出错或 Crash，Incomplete Split Flag 会把没做完的工作记着。

这样的实现确实增加了复杂性。每个 Page 要维护 High Key 和 Sibling Link；搜索多了一次边界检查；Split 要协调多个 Page；Writer 还得应付过期的 Parent Stack 和前人留下的结构修改。少量缺失的 Downlink 还可能让搜索多走几个 Page。

但和长时间锁住整条 Root-to-Leaf 路径相比，这些额外工作通常更划算。

Parent Downlink 的更新可以比子层 Split 晚一步。正常情况下它很快会补齐；就算因为错误留下缺口，B-tree 也有办法继续查询，并在之后修复。

所以，一个 Backend 明明从 Parent 选中了 Block 42，最后却在 Block 73 找到 Key 70，并不代表搜索走错了路。

它只是沿着一次 Page Split 留下的 Rightlink，赶上了正在变化的 B-tree。