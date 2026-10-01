---
author: Neil Chen
pubDatetime: 2026-10-01T00:00:00+08:00
title: Heap Page 里的旧版本，什么时候会被清理
description: 从一个 DELETE 留下的死元组出发，看它经过 Visibility Horizon、Page Pruning、LP_DEAD 和 Index Cleanup，最后能变成什么样；以及 VACUUM FULL 为什么要重新造一份 Heap。
tags:
  - postgresql
  - internals
---

# Heap Page 里的旧版本，什么时候会被清理

上一篇顺着 `heap_insert()` 看了一个 Tuple 是怎么被塞进 Heap Page 的。这次反过来，看它怎么出去。

想观察这件事其实不难。找一张更新频繁的表，会看到 `n_dead_tup` 一直往上走；库里有长事务的时候，VACUUM 跑完回收效果还是很差；DELETE 掉几百万行，文件大小纹丝不动。

这些现象常说成一句「MVCC 会产生死元组」。这话不错，但只说到这里，容易把好几件不同尺度的事压成一个。

一条 Tuple 已经不对新事务可见了，不代表它的字节马上能从 Page 上拿掉；字节可以拿掉了，不代表它占着的那个 `(block, offset)` 能立刻交给下一条记录；就算 Page 内部的空间全都收回来了，Relation 文件也未必会变小。

从旧版本产生，到这块空间最终被后面的写入重新用上，中间大概要走这么多步：

```text
UPDATE / DELETE
        ↓
Visibility Horizon
        ↓
Page Pruning
        ↓
HOT / Line Pointer 整理
        ↓
Index Cleanup
        ↓
Page 内空间重新可用
```

上面这条链路走到头，空间只是回到了 Page 内部，Relation 文件本身还没小。想让这些空间真正从文件里消失，就得多走一段——那是 `VACUUM FULL` 的活儿，留到后半篇再讲。

先挑最简单的一条 DELETE 看起：

```sql
DELETE FROM t WHERE id = 100;
```

假设它命中的是 Heap Page 42 上的第 7 个 Item。

## DELETE 提交了，Tuple 还在原地

执行之前，这一格大概是：

```text
Heap Page 42

offset 7
   |
   v
+----------------------+
| xmin = 100           |
| xmax = Invalid       |
| t_ctid = (42, 7)     |
| user data ...        |
+----------------------+
```

`heap_delete()` 转一圈回来，它还在原来的地方：

```text
Heap Page 42

offset 7
   |
   v
+----------------------+
| xmin = 100           |
| xmax = 250           |
| t_ctid = (42, 7)     |
| user data ...        |
+----------------------+
```

变的只是头部那几个字段。PostgreSQL 顺手改了 `infomask`，把 `pd_prune_xid` 设上，必要时清掉 Visibility Map 上的标记，然后生成 WAL。

但 Page 上并没有因此多出一块 Free Space。Line Pointer 还是 `LP_NORMAL`，Tuple 的字节也还在。`xmax` 从 Invalid 变成了一个 XID，看起来很像「被谁删了」——不过这个字段不是只有删除在写，想单独读它判断什么，得连着 `infomask` 和那个 XID 当时的提交状态一起看。

`pd_prune_xid` 是这里最容易被展开讲的一个字段，但它本质上只是个 Page 级别的提示：告诉后来的人这个 Page 值不值得整理一下。真正的判断不靠它，靠 Visibility Horizon。

这些都是 DELETE 执行路径本身的复杂度。站在空间回收的角度，DELETE 只做了一件事：留下一个内容完整的旧版本。

它没把旧版本从 Page 上搬走，也不太应该。万一事务后来 abort 了，这条 Tuple 得原样留着；已经拿到旧 Snapshot 的事务，也还指望能读到它。

## 提交了，和可以删了，差着一段距离

换个场景：

```text
Session A                         Session B

BEGIN;
取得 Snapshot

                                  DELETE ...
                                  COMMIT

继续用原来那个 Snapshot
```

Session B 已经提交了。这之后开始的事务都看不见那条记录，可 Session A 手里那个 Snapshot 还停在过去，它照样能读到旧版本。

所以 Pruning 和 VACUUM 判断「这条 Tuple 能不能物理删除」的时候，不能拿某个普通查询的 Snapshot 来比。它们要回答的是另一个问题：

> 这个版本，还有没有可能被某个系统必须保护的观察者看到？

这条判断线就是 Visibility Horizon。它不来自某一个 Snapshot，而是系统综合所有活跃事务和正在被保护的状态位后得到的边界，判定的方式始终是「某个 XID 是否落在边界之内」。

源码里的 Vacuum Visibility 大致会把 Tuple 分成 `LIVE`、`RECENTLY_DEAD`、`DEAD`，以及 insert / delete still in progress 这几类。

这里真正能进入物理清理的只有 `DEAD`。`LIVE` 当然不能动；`RECENTLY_DEAD` 也还不能动，它已经完成了删除或更新，只是对应的 XID 还没越过可移除的 Horizon。如果更新事务还在进行，旧版本在这套 Vacuum Visibility 分类里同样表现为 `DELETE_IN_PROGRESS`：从旧版本自身的生命周期看，它正在被另一个版本取代。

所以 `RECENTLY_DEAD` 是理解膨胀的关键。等待并不是因为事务没提交，而是因为 Horizon 还没走过来。

```text
UPDATE / DELETE
       ↓
事务提交
       ↓
RECENTLY_DEAD
       ↓
Visibility Horizon 推进
       ↓
DEAD
```

长事务和表膨胀绑在一起，原因就在这儿。只要系统里还挂着一个足够老的 Snapshot，很多早就提交完的旧版本就一直是 `RECENTLY_DEAD`，谁也不能动它们。Replication Slot、Hot Standby Feedback 这些东西也会从各自的机制出发，把这条线按住不放。

所以看到 `n_dead_tup` 高，光确认「Autovacuum 跑没跑」是不够的。VACUUM 来是来了，也得先有东西能安全地清。

## 到了 DEAD，Page 才轮到自己动手

旧版本终于满足可移除条件之后，才进入 Page Pruning 的范围。这块逻辑现在集中在 `heap_page_prune_and_freeze()` 里。

Pruning 处理的是当前这一个 Heap Page 内部的事：哪些 Tuple Version 可以去掉，HOT Chain 能不能缩短，哪些 Line Pointer 得留着，以及 Page 中间那些空洞怎么压紧。

不过「这个版本可以删」和「它占的位置可以还回去」，中间还差一层。一条 Tuple Version 变成 DEAD，只解决了 MVCC 那一半问题；它原来那个 TID 能不能重新分配，得看别的模块怎么说。

最直接的那个模块就是 Index。

## Index 记的是 TID，不是 Tuple 放在哪

普通 B-Tree Index Entry 里存的是 Heap TID：

```text
(block number, offset number)
```

比如：

```text
Index

key = 100
   |
   v
TID = (42, 7)
```

它知道「Heap Page 42 的第 7 个 Line Pointer」，至于 Tuple 的字节此刻躺在 Page 的哪个偏移上，它完全不知道。

正因为不知道，Page 内部才可以比较自由地整理存储。Tuple 的字节在 Compaction 里被挪到别处，只要改一下那个 Line Pointer 记的页内偏移就行，Index 一个字都不用改。

但反过来就出事了。如果 Tuple 一被清掉，就顺手把 offset 7 标成 `LP_UNUSED`，后面某次 INSERT 又把一条毫不相干的记录放在 offset 7 上，而旧 Index Entry 里还老老实实存着 `(42, 7)`——这条 Index Entry 就指到别人身上去了。

所以需要一个中间状态：`LP_DEAD`。Tuple Bytes 可以先清掉，但这个 Offset Number 还不能重新分配。这样即使旧 Index Entry 仍然保存着 `(42, 7)`，它也不会在索引清理完成前，误指向后来复用这个 Slot 的另一条记录。

说到底，Heap Page 里同时回收着两样东西，而它们的生命周期并不一样：

```text
Tuple Bytes

以及

(block, offset) 这个地址
```

## HOT 让这个区别更明显

这一行更新了两次，每次更新留下一个新版本，所以 Page 42 上现在有三个：V1 是最初那条，V2、V3 是两次更新的产物。

Index 里那一格只有 `(42, 3)`。进了这个 Page 之后，要经过两种跳转才能摸到最新的版本。

第一种是 Line Pointer 数组，它把 Offset Number 对应到页里的 Tuple：

```text
  [3]  -> T1
  [8]  -> T2
  [11] -> T3
```

第二种是 Tuple 头里的 `t_ctid`，它指向同一个 Page 上的下一个版本，把三个版本串成一条链：

```text
T1   t_ctid -> (42, 8)
T2   t_ctid -> (42, 11)
T3   t_ctid -> (42, 11)
```

所以访问是一跳一跳接起来的：Index 说从 offset 3 进，Line Pointer 把 offset 3 翻译成页内的 T1，接着读 T1 的 `t_ctid`，知道要去 `(42, 8)`，于是找到 T2，再顺着 T2 的 `t_ctid` 找到 T3。V3 是最新的版本，`t_ctid` 指回自己，链到头了。

三个版本里只有 V1 被 Index 直接指向。V2 和 V3 都是 Heap-Only Tuple，更新它们的时候没有往 Index 里加条目，所以那格 Index Entry 存的始终是 `(42, 3)`，一次都没变。

现在假设 V1、V2 都 DEAD 了，只剩 V3 活着。两个旧版本的字节留着没意义，可 `(42, 3)` 是 Index 进入这条链的唯一入口，不能断。Pruning 处理完，Line Pointer 数组是：

```text
  [3]  --> (42, 11)
  [8]  (unused)
  [11] -> T3
```

offset 8 那一项作废了，T2 的字节也没了。offset 3 那一项还在，但它已经不需要真的指向一条 Tuple——`LP_REDIRECT` 让它直接指向 `(42, 11)`，从 Index 进来的访问就接着走下去了。

两个 Offset Number 的待遇不一样，分界线就是「有没有人引用」。offset 8 上面是 V2，一个 Heap-Only Tuple，没有普通 Index Entry 直接指向它，所以 Pruning 可以直接把它变成 `LP_UNUSED`，位置当场就还回去，不用等 VACUUM。offset 3 是 Index 的落脚点，哪怕上面的 V1 早就消失了，它也删不得，只能从 `LP_NORMAL` 换成 `LP_REDIRECT`——内容没了，门口还得挂个牌子指路。

这也正是 Line Pointer 数组要独立存在的原因：页尾的 Tuple 在 Compaction 里被搬到了别的位置，可 offset 3 和 offset 11 这两个编号没变，Index 存的那一格就一直有效。

需要停在 `LP_DEAD`、等索引清完才释放的，只有可能仍然被普通 Index Entry 指向的那些位置——HOT 链的 root，或者不属于任何链的普通 Tuple。Heap-Only Tuple 不在其列。

再往后，如果 V3 也 DEAD 了呢：

```text
  [3]  (dead)
  [8]  (unused)
  [11] (unused)
```

`LP_REDIRECT` 换成了 `LP_DEAD`。这一次 Pruning 会把整条链上的 Heap-Only Tuple 一并释放，只有 root 例外——Index 里可能还存着 `(42, 3)`，所以 offset 3 必须停在这儿，等 Index 清完再走。

把几种状态按发生顺序摆出来，比单独背定义清楚。两种路径对照着看：

```text
普通 Tuple     LP_NORMAL -> LP_DEAD   -> LP_UNUSED
HOT 的 root    LP_NORMAL -> LP_REDIRECT -> LP_DEAD -> LP_UNUSED
```

分水岭就是这个 TID 还有没有人在引用它。

## HOT 为什么非要在同一个 Page 里

HOT Update 要求新版本落在旧版本所在的那个 Heap Page 上。这个限制通常和「减少 Index 更新」一起讲，但看完 Pruning 会发现同 Page 还有另一层意思。

只要整条链都待在一个 Page 里，Pruning 要面对的东西就很少：一个 Buffer，一把 Cleanup Lock，还有当前这个 Page 的 Line Pointer 和 HOT Chain。版本判断、Redirect、Tuple 删除、Compaction，一口气都能做完。

要是链可以跨 Page，变成这样：

```text
Page A                       Page B

root ----------------------> 下一个版本
```

事情就不是一个量级了。清理 Page A 的时候得先知道 Page B 的状态，接着一连串问题会自己冒出来：

```text
两个 Page 怎么加锁
两边同时 Pruning 怎么办
WAL 怎么表达一次跨 Page 的 Chain 修改
Index Scan 最坏要追多少个 Page
Page A 上的入口什么时候才能释放
```

一次本来很局部的空间整理，当场升级成一个跨 Page 协议。HOT 把优化机会关在 Page Boundary 里，也顺手把后续维护的复杂度关在了同一道墙内。

## Pruning 不一定要等 VACUUM，但得要 Cleanup Lock

旧版本清理也不是全由 VACUUM 触发的。普通查询访问 Heap Page 的时候，就可能拐进 `heap_page_prune_opt()`。

它先看 `pd_prune_xid`——正是前面 DELETE 顺手设上的那个，再结合当前 Visibility Horizon 和 Page 剩余空间，判断这个 Page 值不值得整理一次。值得的话就试着上一把 `ConditionalLockBufferForCleanup()`：

```text
访问 Page
    |
    +-- 不值得整理
    |
    +-- 值得整理
            |
            v
       尝试 Cleanup Lock
          /      \
       成功      失败
        |          |
      Prune       跳过
```

拿不到锁就跳过，绝不会为了顺手整理 Page 把当前查询卡住。所以 Pruning 更像一种机会性的 Page 维护：一个 Page 完全可能在 VACUUM 扫到它之前，就已经被日常访问清掉一部分旧版本了。

至于为什么非得是 Cleanup Lock 而不是普通的 Exclusive Lock，看 Pruning 的另一半工作就知道了。它不只是改 Line Pointer，还可能调 `PageRepairFragmentation()` 做重排。一个被 UPDATE、DELETE 反复折腾过的 Page，内部很容易长出一堆空洞：

```text
+------------------------+
| Line Pointer Array     |
+------------------------+
|        free            |
|                        |
| tuple C                |
|        hole            |
| tuple B                |
|        hole            |
| tuple A                |
+------------------------+
```

整理之后：

```text
+------------------------+
| Line Pointer Array     |
+------------------------+
|                        |
|   continuous free      |
|       space            |
|                        |
+------------------------+
| tuple C                |
| tuple B                |
| tuple A                |
+------------------------+
```

Offset Number 一个没变，Tuple 的字节全挪了位置。而别的 Backend 可能正握着这个 Buffer，手里还存着指向 Page 内某个 Tuple 的指针。

这就是普通 Buffer Exclusive Lock 不够用的原因。空间可以晚点再收，别人正在用的内存位置可不能随便挪。

## Pruning 先想清楚，再动手

`heap_page_prune_and_freeze()` 还有个执行上的特点：它不是扫到一个 DEAD Tuple 就立刻改 Page。

前面有一轮规划。扫完这一页，它手里先攒出三份清单——哪些 Offset 要转 Redirect，哪些转 Dead，哪些直接 Unused——每个 Tuple 的可见性判定也是在这个阶段做完的。清单成型之后，才进临界区真正去改 Page，最后写 WAL。

WAL 记的是结果本身，也就是这三份清单。Redo 不会再跑一遍可见性判断，因为主库当时已经结合事务状态和 Horizon 做出了决定，恢复阶段只需要重放这些确定的物理结果。这也是很多 WAL 路径的共同思路：把依赖运行时事务环境的复杂判断留在正常执行阶段，让恢复阶段尽量只做确定的状态转换。

## Page 自己能做的，到 Index 就到底了

Pruning 能解决当前 Page 里的绝大多数问题，但它不会为了释放一个 TID 去挨个访问整张表上的所有 Index。需要跨 Index 的那部分，交给 VACUUM。

一张有 Index 的表，大致是这么个来回：

```text
Heap Scan
   |
   | Pruning
   v
产生 LP_DEAD
   |
   | 收集 Dead TID
   v
(42, 7)
(51, 3)
(67, 9)
...
   |
   v
Vacuum Index A
Vacuum Index B
Vacuum Index C
   |
   v
所有 Index Entry 清理完成
   |
   v
回到 Heap
   |
   v
LP_DEAD -> LP_UNUSED   (VACUUM 第二遍)
```

这么分工，Page Pruning 才能一直是 Page-Local 的。它不用为了整理一个 Heap Page 去重算 Expression Index，不用判断 Partial Index 的 Predicate，更不用钻进各个 Index AM 里面。Relation 级的协调留给 VACUUM。

Index 清理完成之后，VACUUM 会回到 Heap，把那些 `LP_DEAD` 翻成 `LP_UNUSED`——这是 VACUUM 的第二遍。所以有 Index 的表上，Pruning 之后停在 `LP_DEAD` 等着的那批位置，要一直挂到索引侧确认没人再引用它们为止；前面提过的 Heap-Only Tuple 不在此列。

如果这张表压根没有 Index，事情就简单很多：反正不会有任何 Index Entry 拿着这个 TID 回来找它，本来该先留成 `LP_DEAD` 的那些 Item，可以直接变 `LP_UNUSED`。

所以 `LP_DEAD` 这个状态，很大程度上就是 Heap 和 Index 清理之间的一块交接区。

## 到这一步，空间回来了吗

如果问的是 Heap 内部可复用的空间，那多半是回来了。

旧 Tuple 的字节被移除，Page 完成 Compaction，Line Pointer 最终走到 `LP_UNUSED`。VACUUM 再把 Page 的空闲量写进 FSM（Free Space Map，每个 Relation 自己的一份空闲空间账本），后面的 INSERT 就有机会重新找到这些 Page。

于是一张频繁更新的表可以停在某个相对稳定的文件大小上，反复用自己内部的空间：

```text
旧版本产生
    ↓
VACUUM / Pruning 回收
    ↓
FSM 记下 Free Space
    ↓
后续 INSERT / UPDATE 再利用
```

这大概就是普通 VACUUM 日常最主要的工作。

Visibility Map 记的是另一码事，它只关心这个 Page 上的记录是不是大家都看得见。UPDATE、DELETE 会让相关 Page 丢掉 All-Visible 标记，旧版本清理干净、条件重新满足之后，VACUUM 再把它设回来。

所以一张更新频繁的表，即使查询能被索引完全覆盖，`EXPLAIN (ANALYZE)` 里也可能看到不少 `Heap Fetches`。

## 可 Page 里的空间回来了，表文件为什么还是那么大

这一层最容易被上面的结论盖住。看一个 Relation：

```text
[ live ][ live ][ live ][ live ][ live ][ live ]
```

经历大量 DELETE 加一轮 VACUUM：

```text
[ live ][ free ][ live ][ free ][ live ][ free ]
```

这些 `free` 已经能被后面的 INSERT 用上了，但它们的位置就在文件中间。文件在磁盘上的 Page 序列没有任何变化，仍然是 Block 0 到 Block N 一路排下去。

普通 VACUUM 的目标是让这些空间重新可用，不是不停搬动存活 Tuple 把文件压到最短。所以这些空间大多不会还给操作系统。有个例外：如果空闲 Page 恰好连续地堆在文件尾部，PostgreSQL 在满足条件时可以把尾巴截掉。

要想把夹在中间的空洞也彻底消掉，就必须移动还活着的 Tuple。Tuple 一移动，TID 就变了：

```text
old TID = (9000, 7)

          ↓

new TID = (100, 3)
```

到这儿，问题已经不是 Page Pruning 的范畴了，整个 Relation 的物理布局都得重建。

## VACUUM FULL 干脆重新造一份 Heap

`VACUUM FULL` 走的是最重的那条路：创建一份新的物理 Heap，把还要留的 Tuple 写进去，最后用新存储把旧存储换掉。官方文档说它「把整张表重写到新的磁盘文件中」（rewrites the entire table into a new disk file），不是就地整理。代价是需要 `ACCESS EXCLUSIVE` 锁，而且中途新旧两份存储得同时留着。

```text
Old Heap

[ keep ][ dead ][ free ][ keep ][ dead ][ keep ]
                  |
                  | rewrite
                  v

New Heap

[ keep ][ keep ][ keep ]
```

这里写 `keep` 而不是 `live`，因为搬过去的并不只是「当前可见的行」。它也不能顺手写成

```sql
SELECT live_rows FROM old;
INSERT INTO new;
```

因为 Heap 里放的不是一组行，是 Tuple Version。

## Rewrite 不能把旧版本都当成新 INSERT

普通 `heap_insert()` 会给新 Tuple 写上当前事务的 `xmin` 和 `cmin`。如果 `VACUUM FULL` 把要保留的 Tuple 当成普通 INSERT 重新插一遍，那这些版本的事务历史就被当前这个 `VACUUM FULL` 事务重新编排了一次。原来的 `xmin`、原来的版本先后关系，全没了。

所以 `CLUSTER` / `VACUUM FULL` 的 Heap Rewrite 有一份专门的 `rewriteheap.c` 来处理这件事：尽量保留旧 Tuple 的 MVCC 信息，同时重新理清版本之间的 `t_ctid` 关系。

比如旧 Heap 里：

```text
T1 @ (10, 3)
 xmin = 100
 xmax = 200
 t_ctid -> (10, 7)

T2 @ (10, 7)
 xmin = 200
```

重写之后它们搬到新位置：

```text
T1' @ (2, 1)
T2' @ (8, 4)
```

那 `T1.t_ctid = (10, 7)` 显然不能照抄，得改成 `T1'.t_ctid = (8, 4)`。

于是 Rewrite 过程中要一直维护 `old TID -> new TID` 的映射。麻烦的是扫描顺序不保证先遇到哪个版本。如果先写的是 T1，而 T2 的新 TID 还没产生，这条关系就只能先记下来挂着，等 T2 真的落到新 Heap 上再回头补 T1；要是先遇到 T2，那就顺手把 `old T2 TID -> new T2 TID` 记进映射，将来 T1 出现时直接取用。

`rs_unresolved_tups` 和 `rs_old_new_tid_map` 这些 Rewrite Local State，存在的理由就是这个。

从这里也能看出来，Heap Rewrite 搬的并不是一行行 User Data，它还得尽量保住这些版本原本形成的事务关系。

也正因为如此，Rewrite 扫旧 Heap 时不是简单的 live 就拷、dead 就扔。`RECENTLY_DEAD` 该复制还是要复制，它还没越过回收 Horizon。而完全 `DEAD` 的 Tuple 虽然不进新 Heap，也还是要看一遍——前面可能已经碰到一条 Tuple，正挂着等它的后继版本。

```text
old version
    |
    | t_ctid
    v
后继版本还没出现
```

后面发现这个后继版本本身就是 DEAD，那条挂起的 Chain 状态就可以结掉了。源码里管这种「还没落地的后继」叫 successor，`rs_unresolved_tups` 里挂着的就是它们。这一点和 Pruning 挺像的：两者都不能只凭「当前查询能不能看见这行」来决定物理数据的命运，它们看的是更长的那个 Tuple 生命周期。

## 新 Heap 写完之后

新 Heap 是写在一份临时 Relation 里的，最后要把原表指过去。这里不能简单地把旧表 DROP、把新表 RENAME，因为原表 OID 上挂着一堆东西：权限、依赖、Trigger、外键、Comment，等等。所以保留的是原表的逻辑身份，换掉的只是它背后的物理 Storage。

换完之后，Index 得按新的 Heap TID 重建一遍，旧 Index 里那些 `(block, offset)` 已经对不上新 Heap 了。这也是 Rewrite 采用「先造新 Heap，再切 Storage，最后重建 Index」这个顺序的原因。

另一个问题是中间失败怎么办。Rewrite 的 Copy 阶段可能很长，出 ERROR 很正常。如果是在旧文件上原地重写，写到一半失败，就得面对一堆一半新一半旧的 Page，很难收拾；另外造一份新存储就简单了，失败就删掉新的、旧的原样还在，成功就反过来，哪份留下等于替这次操作收了尾。

这个「删新的还是删旧的」并不是一句设计描述，源码里对应的是 pending storage delete 这套记录：新的 storage 登记成 abort 时删，旧的 storage 被替换之后登记成 commit 时删。也就是说，成功和失败各自要删哪一份，在事务提交或回滚的那一刻就被确定下来了，不需要再去修复重写过程本身。

这也算是 Heap Rewrite 里比较巧妙的一点：重活慢慢做，真正对外切换的边界压到最后一步；真出了错，靠「哪份 Storage 留下」来收场。

## 普通 VACUUM、VACUUM FULL 和 CLUSTER

普通 VACUUM 在现有 Heap 上干活，前面那几张图讲的都是它。核心目标是让一张长期更新的表进入稳态，而不是把文件始终压到最小，这样比反复重写整张表划算得多。

`VACUUM FULL` 处理的是另一个尺度。当回收出来的空间大量留在 Relation 内部、散落在文件各处，靠 Page 内复用已经无法把物理文件压下去时，它才选择 Rewrite 整个 Heap、换掉底层 Storage。问题解决得更彻底，代价也大得多。

`CLUSTER` 复用的是同一套基础设施，区别只在重写的目的——`VACUUM FULL` 要让留下的 Tuple 紧凑地排好，好把文件里的空洞收回来，而 `CLUSTER` 希望它们尽量按指定 Index 的顺序排布。走到物理重写这一层，两者面对的问题一样：TID 全部变化，Version Chain 要处理，Index 要重建，新旧 Storage 要切换。

## 回到最开始那条旧版本

一个旧版本从产生到空间被重新用上，中间要经过 Visibility Horizon、Page Pruning、`LP_DEAD` 这道交接，以及 Index Cleanup。空间回到 Page 内部并且被后续写入重新用掉，这条线就走到头了。

再往下就只有一种情况会继续：空闲空间大量留在 Relation 内部，目标又是把物理文件压下去。到那一步，才轮到 `VACUUM FULL` 重建整个 Heap。

这么看下来，PostgreSQL 里「清理旧版本」并没有一个统一的删除动作。MVCC 决定旧版本什么时候不再需要被保护；Pruning 尽量在 Page 内把局部整理做完；VACUUM 处理 Heap 和 Index 之间的引用；FSM 把回收结果交给后面的写入路径；等到整个 Relation 的物理布局已经不值得继续修补，`VACUUM FULL` 才选择直接重建一份 Heap。

`LP_REDIRECT`、`LP_DEAD`、Rewrite 的 TID 映射、Storage Swap 分散在不同模块里，但它们处理的是同一个约束：数据本身可以先消失，围绕它存在的引用和物理身份，则要等最后一个使用者处理完，才能真正释放。
