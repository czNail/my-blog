---
author: Neil Chen
pubDatetime: 2026-10-31T00:00:00+08:00
title: FullXID 已经是 64 位，Heap 里为什么还是 32 位？
description: 全局事务号分配器早就用上了 64 位的 FullTransactionId，Heap Tuple Header 里的 xmin/xmax 却还是 32 位。从 Freeze 的成本出发，看 Page Base、半 Epoch 编码和 Lazy Freeze 想把这件事改到哪一步。
tags:
  - postgresql
  - internals
---

# FullXID 已经是 64 位，Heap 里为什么还是 32 位？

从 PostgreSQL 12 开始，全局事务号分配器用的就是 64 位的 `FullTransactionId`，下文简称 FullXID。这个类型由两部分拼成：高 32 位是 Epoch，记的是低 32 位转过几圈；低 32 位是原来的 `TransactionId`。Heap Tuple Header 里的 `xmin/xmax`，到今天还是那个 32 位的 `TransactionId`。取号时 Epoch 清清楚楚，落到 Tuple Header 上却只剩 32 位。

这个落差平时不太显眼。之前聊 Heap 旧版本清理，VACUUM 干的活都很好理解：UPDATE、DELETE 留下旧 Tuple，等没人再需要，把空间收回来。那套流程和事务号长度没多大关系。

但有一类开销跟 Dead Tuple 无关。一张表哪怕很久没动过，只要全局 XID 一直涨，还是可能被 aggressive VACUUM 扫到。这种扫描为了推进冻结下界，会检查所有尚未确认整页冻结的页面。页上的记录早就稳定了，却可能还要为了 Freeze 改一遍，改完还要写 WAL、写数据页。

这类开销只发生在还没冻结的稳定页上。已经冻结、之后也没有变化的页，不会仅仅因为全局 XID 增长就需要再次冻结，aggressive VACUUM 也可以跳过它们。

这笔写入之所以存在，是因为 Tuple Header 只存得下 32 位事务号。分配器那边早就是 FullXID，页面上还没跟上。

2026 年 5 月，Alexander Korotkov 整理出一条渐进式的改造路线，想把 64 位事务号再往 Heap 里推一步，其中比较关键的两步是 Page Base 和 Lazy Freeze。下面按这条路线展开，看看这份提案建议怎样处理长期保存的事务历史，也看看 Heap 里的两个 32 位字段为什么未必需要真的扩成 64 位。

## FullXID 管理取号，Heap 却要保存历史

`GetNewTransactionId()` 从 `TransamVariables->nextXid` 拿到的是完整的 FullXID，写进 Tuple 之前再截成低 32 位。

对运行中的事务来说，32 位够用。ProcArray 和 Snapshot 关心的只是一段活跃事务窗口，只要同时运行的事务之间 XID 跨度不超出 2^31，32 位编号就足够判断先后和可见性。

Tuple 不遵守这个节奏。事务结束、从 ProcArray 里退出之后，它留下的版本还能在 Heap 上躺很多年。某条 Tuple 的 `xmin = 100`，等 32 位空间转过一圈，再出现一个 100，单看这个数字已经分不清它属于哪一轮。

`FullTransactionIdFromAllowableAt()` 这类接口能把短 XID 补回完整事务号，前提是这个 XID 还落在允许的历史窗口里。对任意古老的事务号，这个前提保不住。传统 PostgreSQL 必须及时 Freeze：趁旧 XID 还能被正确解释，把足够古老、已经提交的插入事务标成 Frozen。以后判断这个插入事务的可见性，就不必再查询它的提交状态。

还有 `pg_xact`。

提交结果存在这里，运行状态在 ProcArray，子事务的父链在 `pg_subtrans`，MultiXact 另有一份成员记录。这些文件都不会无限保留，但清理依据并不相同。`pg_xact` 的截断依赖各数据库冻结下界的推进，MultiXact 有自己的清理下界，`pg_subtrans` 则根据仍需保留的活跃事务历史，在 Checkpoint 时截断。等到相关状态被截断，Heap 上留下的 Tuple 就不能再依赖它们判断可见性。

于是矛盾摆在这儿：分配器知道完整事务号，Heap 和事务状态存储却都建立在 32 位 XID 上。Freeze 是两者之间的桥，维护这座桥的成本，就是开头提到的那笔写入。

提案先想到的，是让 Heap 自己记住完整事务号。

## 把事务号的高位放到 Page 上

最直接的做法，是把 Tuple Header 里的 `xmin/xmax` 扩成 64 位。思路简单，代价也直接：每条 Tuple 多 8 字节。

Tuple Header 本来就在跟空间较劲。Heap Page 只有 8KB，一条短记录可能才几十字节，再加 8 字节，一页能装的记录数、缓存命中率、顺序扫描的 I/O 都会受影响。为了一个大部分页面根本用不上的高位，让所有 Tuple 一起付钱，不太划算。

Page Base 换了个思路：同一个 Heap Page 上的 Tuple，共享一份高位。

```text
Heap Page
+----------------------------------+
| Page Header                      |
+----------------------------------+
| Tuple A: xmin = 100              |
| Tuple B: xmin = 500              |
| Tuple C: xmin = 900              |
+----------------------------------+
| Page Special Area                |
|   pd_xid_base   = B  (32 bit)    |
|   pd_multi_base = M  (32 bit)    |
+----------------------------------+

FullXID(A) = (B << 31) + 100
FullXID(B) = (B << 31) + 500
FullXID(C) = (B << 31) + 900
```

Base 放在 Special Area（页尾预留的一块固定区域）里，Tuple 继续存 32 位的短编号（ShortXID）。还原完整事务号时，把 Base 左移 31 位，再加上 ShortXID。Base 不跟着 Tuple 走，摊薄到每条 Tuple 上几乎可以忽略。

不过 Special Area 里要放两份 Base。

`xmax` 有时候存的不是 XID，是 MultiXactId。之前看 Heap UPDATE 和行锁时提过：多个事务同时持有兼容的行锁，PostgreSQL 会用一条 MultiXact 记下成员事务和各自的锁模式。XID 和 MultiXactId 有各自的分配器、编号空间和增长速度，共用一份 Base 会打架。所以这份提案在 Special Area 里放两个 32 位字段，一个给普通 XID，一个给 MultiXact；读 `xmax` 时看 infomask 里有没有 `HEAP_XMAX_IS_MULTI` 标记，决定用哪一份。

加起来 8 字节，是一页的固定开销，不随 Tuple 数量增长。

不同 Page 可以用不同的 Base。全局事务号涨到多大都无所谓，只要这一页里需要编码的事务号跨度还装得下，ShortXID 就还是 32 位。

问题在于，窗口是会满的。

## Page Base 也有挪不动的时候

一页不可能永远只装同一批 Tuple。某条很老的记录一直没被清掉，页上又不断插入新版本，事务号一路往上走，总有顶到窗口边缘的时候。

那就得挪 Base。

麻烦的是不能只改 Base。原有 Tuple 的 ShortXID 也得跟着调，否则同一个 ShortXID 配上新的 Base，解出来就是另一个事务。

挪 Base 时，得保住这个等式：

```text
(oldBase << 31) + oldShortXID
    =
(newBase << 31) + newShortXID
```

Base 往前挪，老 Tuple 的 ShortXID 就要相应减小。两个约束跟着来：新事务号得落进调整后的窗口；页里最老的那批事务号，也不能被挤出窗口。

如果一页上最老的和最新的相距太远，已经找不到一个 Base 同时容下它们，光挪 Base 就不够了。

这时候还是得回到 Freeze：先把最老的那批 Tuple 冻结掉，让它们退出普通 ShortXID 的编码范围，再重新算窗口。前提是这些 XID 已经满足安全冻结条件。如果还有相关事务或旧 Snapshot 挡住冻结下界推进，就不能靠冻结腾出窗口。

Page Base 并没有让 Freeze 消失，只是把判断从「全局下界」变成「全局下界加这一页的窗口」。一页要挪 Base，未必需要 Freeze 整页，可能只动最老的那一小段，不必等整个库的 Freeze 周期。

Base Shift 改的是页面上保存的 Base 和一批 Tuple Header，WAL 里得有对应的记录。执行时把调整量算好，恢复时照着 WAL 重放编码变换，不必在 Redo 阶段再查事务状态、重新决定挪多少。这跟之前看 Heap Pruning 时那条线一样：依赖运行时环境的判断留在正常路径，Redo 只重现确定的结果。

## 为什么是半个 Epoch？

再看一遍这条编码：

```text
FullXID = (PageBase << 31) + ShortXID
```

PageBase 和 ShortXID 都是 32 位。左移 31 位而不是 32 位，是为了让相邻两个 Base 的窗口重叠一半：一个 Epoch 对应低 32 位 XID 的一整轮，也就是约 2^32 个编号位置；Base 每加一，窗口只前进 2^31，正好是半个 Epoch。

把 ShortXID 缩到 4 位来看，它能表示 0 到 15。Base 每加一，窗口起点往前挪 8：

```text
Base = 0: [ 0 ............. 15 ]
Base = 1:         [ 8 ............. 23 ]
Base = 2:                 [ 16 ............ 31 ]
```

完整事务号 12 于是有了两种编码：

```text
Base = 0, ShortXID = 12

Base = 1, ShortXID = 4
```

两种都能还原出 12。

回到 32 位的实际情况：每个 Base 覆盖 2^32 的编号范围，相邻窗口的起点相差 2^31，32 位 PageBase 合起来给出约 2^63 的全局编号空间。它没有覆盖完整的 64 位无符号整数，但已经大得足够用。

重叠带来的是余地。前面的 4 位例子里，一个 Epoch 是 16 个编号，15 和 16 分属相邻的两个 Epoch。如果窗口只能按整 Epoch 对齐，就没有一个窗口能同时容下它们；允许按半个 Epoch 对齐之后，Base = 1 的窗口覆盖 8～23，正好能把它们放在一起。

窗口能重叠，不等于 Base 可以随便挪。调整之后，所有还要用普通编码的事务号都必须落进新窗口，否则就得先 Freeze。

还有一个设计选择挺关键：运行中事务之间 2^31 的跨度限制被保留了下来。

这个限制原本是给 32 位 XID 的比较和可见性判断用的。Heap 能保存更长久的历史，不代表两笔相隔几十亿个 XID 的事务需要同时跑。一条 Tuple 可以存在几十年，活跃事务窗口却没必要跟着放大。

所以 ProcArray、Snapshot 这些机制继续用 32 位的 `TransactionId`，只有需要完整事务号的地方才用 FullXID。多出来的高位只服务于持久化这一侧。提案选择先把 Heap 保存历史的能力撑大，而不必同时把整个运行时事务协议重写一遍。

## Lazy Freeze：旧 Page 能不能少写一次？

Page Base 解决的是「读得懂」，不是「不用写」。

回到开头那个问题：aggressive VACUUM 照样会为了 Freeze 去改那些长期没变化、但还没冻结的页。这部分写入不减少，改造的收益就缺了一块。

Lazy Freeze 针对的正是这里。

拿一个 Heap Page 来说，上面的 Tuple 全都稳定，没有 Dead Tuple 要清，也不需要 Pruning。随着 XID 增长，这些 `xmin` 越来越老。传统做法是让 VACUUM 把页上的 Tuple 逐个标成 Frozen，整页随之变脏，产生 WAL，之后还要写回磁盘。改动的可能只是几个字节，代价却是一整页。

有了 Page Base，读的时候已经能还原完整 XID。如果某个 `xmin` 足够老，数据库也确认它背后的历史可以安全地不再查询，读路径就可以把它当成 Frozen 处理，不必等磁盘上的 Tuple 先被改过。

这要求读路径手里有完整 XID。只有 32 位 `xmin` 的话，XID 转过几圈之后，单看这个值已经分不清它属于哪一轮，更没法判断它是否落在冻结下界以下。在这份提案里，Lazy Freeze 就建立在 Page Base 之上：读路径要靠它把完整事务号还原出来。

`relfrozenxid`（每个 relation 记录的冻结下界）在这里换了角色。

传统设计里，推进这个下界之前，必须保证更老的 XID 已经在 Heap 上处理干净——要么被 Freeze，要么被回收。Lazy Freeze 想拿它当判断依据：下界以下的历史，读的时候按 Frozen 解释，磁盘上的原始 XID 留着不动。

Lazy Freeze 省掉的是把 Frozen 标记写进 Tuple Header 的那次写入，不是 Freeze 本身。这些 XID 仍然要满足安全冻结条件，冻结下界仍然要推进；变的只是 VACUUM 不必为了这个标记去改页面。

这和 Page Base 的窗口条件不是一回事。窗口够不够，决定的是要不要 Base Shift；即使跨度装得下、不需要挪 Base，只要 `pg_xact` 还要截断，冻结下界仍然要越过这些老 XID。Lazy Freeze 让这一步不必落到页面上。

多一次比较不算什么，难的是这个下界怎么安全推进。

一个已经回滚的 INSERT，也会在 Heap 上留下带旧 `xmin` 的 Tuple。XID 老，不代表它创建的那行有效。`xmax` 更麻烦：它可能表示删除、更新或行锁，也可能是 MultiXactId，每种状态要分开处理，MultiXact 还有自己的下界。

所以 aggressive VACUUM 还是得把旧历史翻一遍：确认哪些 Tuple 能直接按 Frozen 解释，哪些还带着不能忽略的状态，还要看推进下界之后，数据库是不是真的不再需要那些已被截断的事务结果。

只是检查完，不一定非要把每个旧 XID 都写回去。一页没有 Dead Tuple、也没有别的内容要改，只剩冻结这一件事，VACUUM 就可以只做检查然后走开，不再为了打个 Frozen 标记把页弄脏。

省下来的 I/O 就在这里。一次这样的修改除了产生 WAL 和后续数据页写回，在满足条件时还可能带来 Full Page Image。

边界也清楚。有 Dead Tuple 要回收，页还是得改；Base Shift 撞上窗口限制，可能要在局部做 Freeze；Visibility Map 之类的元数据同样会变。省掉的是「单纯为了 Freeze」的那部分写入。

我觉得这是整个方案里最值得看的一步。Lazy Freeze 本身没有再加什么新的存储结构，只是让读路径把已有的信息用起来，把原本必须提前写进 Page 的状态挪到了读取时判断。

## 有了完整 XID，事务状态还要清理吗？

要。

Page Base 只回答「这条 Tuple 属于哪个事务」，不回答「那个事务提交了没有」。

`pg_xact` 存提交结果，`pg_subtrans` 存子事务父链，MultiXact 有自己的编号和成员存储。它们迟早都要截断，只是各自的清理依据不同。

变化在于紧迫性。过去 32 位窗口把 Heap 和历史存储绑在一起，旧 XID 必须赶在窗口滑走之前处理掉，否则后面就解释不了。现在 Heap 能自己记住完整 XID，处理的节奏可以放缓，但「什么时候能扔掉旧状态」仍然要由 VACUUM 这类维护过程担保。

所以就算将来去掉传统的 Anti-Wraparound 紧急保护（XID 逼近回卷时强制冻结的那条路径），aggressive VACUUM 也不会随之消失。它还要推进清理下界；普通 VACUUM 该做的旧版本和索引清理也照旧。

这份提案还建议给 `pg_xact`、MultiXact 这些 SLRU（按页缓存的事务状态文件）加上 64 位寻址，让不同 Epoch 下的事务结果能被正确定位。Heap 存得下完整 XID、状态存储认得出完整编号、旧历史能安全截断，这三件事得一起成立，方案才算完整。

## 已经存在的 Heap Page 怎么办？

事务语义之外，还有个很实际的问题：升级前就已经写在磁盘上的旧页，没地方放 Base。

新版本新建的页可以预留 8 字节的 Special Area，可这些旧页的尾部没有留出这块位置。`pg_upgrade` 不会重写数据页，旧页会原样留在新库的 Heap 里。为了加两个字段，让升级时把所有 Heap Page 重写一遍，这个部署成本没人愿意接受。

对这类旧页，这份提案建议复用页头现有的字段：用一个新页标志区分格式，把 `pd_prune_xid` 这类字段拿来存 Base，读的时候按标志决定从哪里取。

这样新旧页可以共存，升级不必统一重写。

代价是 `pd_prune_xid` 原本是 Pruning 的提示信息，挪作他用之后，相关判断都得跟着改。WAL Redo、Heap AM 和 `pg_upgrade` 也都要认识两种格式和它们之间的转换。

这里还牵出一个模块边界。页头和 Special Area 都是通用页面结构，XID Base 的含义却只属于 Heap。提案希望把这层转换留在 Heap AM 里，别把 Heap 的私货塞进通用 Buffer Manager。

存储格式一旦落盘，就是往后很多年都甩不掉的兼容约定。这部分工作不如半 Epoch 编码显眼，却直接决定方案能不能平稳落地。

## 为什么要分阶段推进

五月那条路线是分阶段的。第一步是整理 Heap XID Accessor，把散落在各处的读写事务号代码收进统一接口。接着引入 Page XID / MultiXact Base，再做 Lazy Freeze。旧页兼容和 SLRU 的 64 位寻址排在后面，传统的 Anti-Wraparound 维护机制放到最后。提案的目标版本是 PostgreSQL 20，具体方案还要过 Patch Review。

顺序有讲究。

Page Base 和 Lazy Freeze 排在前面，后面 SLRU 的 64 位改造还没完成时，前面这些工作已经能减少一部分 aggressive VACUUM 的写 I/O。

更重要的是可以分开验证。Accessor、Page Base、冻结语义、SLRU 寻址，每一块都能单独测。真要一次性把 ProcArray、Snapshot、Heap、VACUUM 和事务状态存储全搅进去，出了问题很难定位。

事务可见性尤其如此。普通回归测试可能全绿，问题要等在大量 XID 分配之后，或者碰上 Freeze、Base Shift、Crash Recovery、Hot Standby、版本升级的某种组合才冒出来。

拆开之后，每个阶段的正确性约束更清楚，Review 和测试也更容易聚焦。

成本也摆在那儿。读事务号多一层转换，Base Shift 多一份页内维护，WAL 要认识新的修改方式，新旧页格式可能长期共存。这些复杂性能不能换来收益，还得看 Patch 的实现和测试结果。

但我比较认同这条路线：不动已经成熟的运行时事务机制，先把持久化历史能表达的范围撑大，再回头处理 32 位限制留下的维护成本。

## 再看 Heap 里的两个 32 位字段

回到开头。

FullXID 早就是 64 位，Heap 里的 `xmin/xmax` 还是 32 位，单靠它们已经分不清一个事务属于哪一轮。为了避免这种歧义，PostgreSQL 必须及时 Freeze，并推进事务状态的清理。

Page Base 让 Heap 能记住更长久的事务号，同时保住 Tuple Header 的大小。它要处理页内窗口，但不必让每条 Tuple 都多背 8 字节。

Lazy Freeze 再往前一步：数据库确认某段旧历史可以按 Frozen 解释之后，读路径就能完成这个判断，那些已经稳定、只差完成冻结的页，就有机会省掉这次专门修改 Tuple Header 的写入。

事务状态文件还是要清，VACUUM 也还有很多活要干。可对一张长期不动的表来说，全局 XID 计数器往上走，不该变成它的额外写入负担。

如果这次改造最终能让这些 Heap Page 省掉 Freeze 带来的那次写入，就已经很值了。至于 `xmin/xmax` 要不要变成 64 位，反倒没那么要紧。
