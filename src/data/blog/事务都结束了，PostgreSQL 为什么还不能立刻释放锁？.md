---
author: Neil Chen
pubDatetime: 2026-07-31T09:00:00+08:00
title: 事务都结束了，PostgreSQL 为什么还不能立刻释放锁？
description: 不是 PG 拖拖拉拉不想放锁，是放锁这件事本身就是在告诉其他人"我弄完了，你们可以进来了"。
tags:
  - postgresql
  - internals
---

# 事务都结束了，PostgreSQL 为什么还不能立刻释放锁？

做数据库的，没人喜欢锁。

每次数据库卡了慢了，我们都会熟练地敲出那条查锁等待的 SQL，找到是谁在阻塞，心里骂一句：就不能快点 commit？不行 rollback 也行啊。

直觉上，事务结束——管它提交还是回滚——锁就该当场释放。一秒都别多占。

但 PostgreSQL 不这么干。它把资源释放拆成了三步：

```
  BEFORE_LOCKS   →   放锁    →   AFTER_LOCKS
```

一个事务收个尾，凭什么以"放锁"为界拆三段？

## 锁放早了会怎样

问题不在锁的持有者，在排队那帮人身上。

Backend A 持着一把 relation lock，Backend B 在等。对 A 来说，事务完了，锁没用了，扔了。但对 B 来说，锁被释放的意思是：现在安全了，我可以继续了。放锁是一个信号。

如果 A 放完锁才开始清东西：

```
时间 ──────────────────────────────────────────────────────>

Backend A                        Backend B
  │                                │
  ├─ 持有锁 ────────────────────   │  等待中...
  │                                │
  ├─ 释放锁 ──┐                    │
  │            │  被唤醒 ────────►  ├─ 拿到锁！
  │            │                    │
  ├─ 还在清 buffer pin...          ├─ 开始访问共享状态
  ├─ 还在清 relation...             │
  │            │                    │  A 已经打开并发边界，
  │            │   ◄── 危险窗口 ──► │  但锁前清理尚未完成。
  ▼            ▼                    ▼
```

不是说 B 一定原地爆炸，内核也没有脆弱到少清一个 pin 就直接崩掉。问题是，A 已经允许 B 越过这条并发边界，自己却还保留着可能影响对象生命周期、资源回收或后续操作的状态。嘴上说"可以进来了"，实际却还没有退到协议要求的位置。

所以不能先放锁再清。那先清什么？

## 锁前清什么

PG 在放锁之前会先走 BEFORE_LOCKS 阶段的 ResourceOwner 资源释放——buffer I/O、buffer pin、relcache ref、DSM segment——并在阶段之间穿插模块级的事务清理：buffer、relcache、typecache 的收尾，以及 catalog invalidation 消息的发送。它们不全挂在 ResourceOwner 账本里，但都必须发生在放锁这条边界之前。

这里最容易忽视的是 invalidation。假设事务里 DROP 了一张表。提交时，PG 必须先把自己对这张表的 relcache ref 释放了，再把"这张表没了"的 invalidation 消息发出去，最后才能放锁。顺序不能换。

因为等锁的 backend 被唤醒后，第一件事就是检查有没有新的 invalidation 消息。如果 A 先放了锁，inval 还没发，被唤醒的人就会在一个已经过时的 catalog 视图上继续干活——它看到的还是表存在时的世界。

invalidation 放在锁前，就是要保证：**被唤醒的 backend 看到的世界，已经包含了当前事务的所有 catalog 变更。**

同样的逻辑适用于 buffer pin。锁放了以后，别人可能立刻访问同一个 relation 的 buffer。如果你的 pin 还没解，就影响 buffer 的替换、回收甚至 truncate。

所以放锁之前干的不是"共享资源优先"，而是：把那些会影响被唤醒的人判断的占用全部清掉。清干净了，才能对别人说"你可以进来了"。

## 锁后可以慢慢来

既然这么讲究，那把一切全清干净再放锁呗？

不行。等锁的人监控都刷穿了，你多拿一秒，别人多等一秒。只要不影响其他人继续跑，就没理由让人陪你耗。

所以 AFTER_LOCKS 主要处理那些不会再影响等待者越过当前锁边界的 backend-local 引用和句柄：

- **Catcache ref**：catalog change 对别人的可见性已经由锁前的 invalidation 保证了。catcache ref cleanup 是 backend 自己还引用计数，跟别人没关系。
- **Snapshot ref**：ResourceOwner 只追踪 snapshot 对象的引用计数。全局 xmin 和活跃事务栈的管理由 ProcArray 和 snapmgr 另走一条路，不靠三阶段释放。
- **TupleDesc ref、plancache ref 等**：执行计划的缓存引用、类型描述符引用，纯本地。

此外，事务结束流程还会把物理文件删除推迟到放锁之后。`smgrDoPendingDeletes(true)` 并不属于 ResourceOwner 的 AFTER_LOCKS 资源，但它遵循同样的取舍：DROP TABLE 之后实际删除文件可能耗时很久，其他 backend 已经能通过 catalog 变化知道这些文件不该再访问，没必要继续占着锁慢慢删。

所以三阶段本质上是在两个烂选项之间拉了条平衡线：放太早，公共状态可能还是乱的；放太晚，早就可以进人了还让人排着。

## 同一阶段里也得排队

就算都是锁前的资源，也不能一拥而上。PG 给每种资源定义了阶段内的优先级。

Buffer I/O 必须先于 buffer pin 释放——需要先把正在进行的 I/O 状态结束或撤销，再处理普通 pin，否则 cleanup 可能先拆掉 I/O 路径仍然依赖的占用关系。Relcache ref 必须在 invalidation 之前释放。有些资源挂在更底层的执行状态上，顺序反了，cleanup 自己踩到已经拆掉的东西也不奇怪。

所以真实的释放顺序是嵌套的：先判锁前/锁/锁后，同一阶段内按优先级排队，ResourceOwner 有嵌套的话先清子节点再清父节点。这些顺序不是设计文档拍脑袋定的，是依赖关系逼出来的。

## 子事务的账怎么算

上面说的都是顶层事务。子事务是另一回事。

```sql
BEGIN;
SAVEPOINT s1;
-- 拿了锁
RELEASE SAVEPOINT s1;
-- 外层继续
COMMIT;
```

`RELEASE SAVEPOINT` 之后，子事务确实提交了。但锁不能放。因为这些改动还在外层事务名下，对外面的人而言事务根本没结束。savepoint 一提交你就放锁，外层明明还在跑，别人已经越过并发边界了。

所以子事务提交时，锁不是释放，是**转移**给父 ResourceOwner——继续算在父事务头上。子事务回滚时不同，当前层级的修改撤销，资源就地释放，外层继续。最后顶层事务结束时，才真正走三阶段放锁。

ResourceOwner 管的不是"这个 C 对象什么时候销毁"，而是：**这笔资源的责任现在归谁，它应该活到哪个边界。** 表面在管对象，实际在管责任。

## 这套机制怎么搭起来的

说到这儿，你可能好奇：PG 怎么记住"谁欠了哪些资源"？

要靠两套机制。**MemoryContext** 管 `palloc()` 出来的内存，reset 一个 context 就是批量把 chunk 还给 allocator。**ResourceOwner** 管的完全不同——buffer pin、锁、snapshot、catcache ref、文件句柄。这些东西的释放不是把内存标记为 free，而是有语义的操作：unpin buffer 要改共享 buffer descriptor、更新 refcount、可能还要唤醒等待者。

MemoryContextReset 干不了这些，它根本不知道什么 buffer pin。所以 PG 必须另起一套账本：ResourceOwner。

ResourceOwner 并不保存 buffer、锁或 snapshot 本体，它只保存一笔 ownership 记录：当前 owner 对某项外部资源负有释放责任。每种资源通过 `ResourceOwnerDesc` 声明自己的释放阶段、优先级和 callback，框架只负责在合适的时机调用它们。这样加一个新模块的新资源，不需要改事务结束函数的主逻辑，声明自己的语义就行。

### 顺便说一句：账本也不能在关键时刻没纸

三阶段释放的前提是每一笔资源都登记在账上了。但登记本身也需要内存——账本不是凭空存在的。PG 的处理方式很干脆：先确保账本有纸，再往上面写。

获取资源之前，先调 `ResourceOwnerEnlarge()` 在账本里预留空间。这一步可能分配内存，如果 OOM 就 ERROR，但此时还没获取外部资源，不需要兜底。空间预留好之后，再去获取资源，成功以后立刻 `ResourceOwnerRemember()` 登记——基本不会再失败。

如果反过来——先获取资源，再在 Remember 里按需扩容——扩容时 OOM → ERROR → 资源已经生效但账本没记录 → abort cleanup 找不到它，漏了。

就这一个预分配顺序，把"获取成功但随后 ERROR"的竞态窗口堵死了。正常路径释放时先 Forget 再实际释放；commit 时发现漏了 Forget 会打 WARNING，abort 时有残留是正常的兜底，静默处理。

### 为什么不写成一串 cleanup

看到这你可能觉得绕：就不能按固定顺序写一溜 cleanup 函数吗？释放 buffer → 清理 relation → 发 inval → 放锁 → 清 snapshot → 关文件。多清爽。

问题是 PG 里的资源来自太多模块：顶层事务的、子事务的、Portal 的、正常路径早就自行释放的、只在 ERROR 时兜底的，新功能还会往里加。要把这些知识全硬编码进事务结束函数，事务模块很快就变成一个什么都得管的巨型开关。

所以 PG 把责任拆开：ResourceOwner 负责账本，每种资源自己说明该在哪个阶段放、怎么放、优先级多少，事务结束流程依次推过锁前→锁→锁后。复杂是复杂了点，但每个模块只需要管好自己的事。

## 最后

回到开头：事务都结束了，PostgreSQL 为什么还不能立刻释放锁？

因为"事务结果定了"和"已经安全退出共享状态"是两件事。放锁不是简单的资源归还，它在对所有人宣告：我的共享工作全部完成，invalidation 已发出，buffer 占用已解除，你们现在看到的是最新最完整的世界。

这句话说出口之前，得先把还能影响别人的占用清干净。说出去之后，剩下的自己的东西慢慢来。锁既不是第一个该放的，也不是最后一个——它卡在整个退场流程最微妙的那条线上。

下次再在监控里看到一排锁等待，大概还是会烦。这个东西确实没人爱看。

但 PostgreSQL 不是单纯在拖延。它只是要在放锁之前，把"你可以进来了"变成一份可信的承诺。三阶段、优先级、子事务转移，以及 Enlarge→Remember 的顺序，看起来都是额外成本，但它们在维护同一件事：**锁一旦释放，后来者看到的就必须是一个已经准备好的世界。**

在并发系统里，一个不可信的"可以进来了"，远比多等几步 cleanup 昂贵。
