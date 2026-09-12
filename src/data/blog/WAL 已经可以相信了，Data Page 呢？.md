---
author: Neil Chen
pubDatetime: 2026-09-12T00:00:00+08:00
title: WAL 已经可以相信了，Data Page 呢？
description: COMMIT 返回时，被修改的 Data Page 往往还留在 Shared Buffers 里。WAL Flush 已经把 fsync 算进自己的语义，Data Page 却把 write 和 sync 拆成两步，中间还隔着一次责任交接。
tags:
  - postgresql
  - internals
---

# WAL 已经可以相信了，Data Page 呢？

上一篇看到 COMMIT 的时候，最后停在了 WAL Flush。

一笔事务产生的 WAL Record 已经进入 WAL Stream，Commit Record 也拿到了自己的 LSN。同步提交下，PostgreSQL 要等：

```text
Flush LSN >= Commit LSN
```

然后才把 `COMMIT` 返回给客户端。只要 WAL 持久化到了这里，即使数据库下一秒崩溃，恢复这笔事务需要的信息也已经留下来了。

但一条 INSERT 显然不只改了 WAL。Shared Buffers 里的 Data Page 也变了。

```text
                   INSERT
                      |
             +--------+--------+
             v                 v
        Dirty Page         WAL Record
                               |
                               v
                           WAL Flush
                               |
                               v
                            COMMIT
```

注意左边那条线。COMMIT 返回的时候，Dirty Page 完全可能还待在 Shared Buffers 里。

这不影响事务提交。要是每次 COMMIT 都顺便把事务碰过的 Heap Page、Index Page 一起 `fsync()`，WAL 也就没那么好用了。PostgreSQL 允许事务持久化和 Data Page 写回走不同的节奏。

于是上一篇的问题还剩下一半：

> WAL 已经可以相信了，Data Page 呢？

## COMMIT 之后，Page 还可以慢慢来

Page 被修改以后，通常只是 `MarkBufferDirty()`，然后继续待在 Shared Buffers 里。什么时候真正写回，由后面的系统活动决定：可能是 Checkpointer，可能是 Background Writer，也可能某个 Backend 想复用一个 Buffer Slot，结果挑中的 victim 还是 dirty，只好自己把它写出去。

所以：

```text
transaction commit time
        !=
data page writeback time
```

这一点 WAL 已经替我们兜住了。Data Page 真正写出去之前，PostgreSQL 要保证对应 WAL 已经先持久化，也就是熟悉的 WAL-before-data。`FlushBuffer()` 里大致就是：

```c
recptr = BufferGetLSN(buf);

if (permanent)
    XLogFlush(recptr);
```

这部分没什么神秘的。比较值得继续追的是源码里的下一句：

```text
Now it's safe to write the buffer to disk.
```

它说的是**现在可以安全地开始写**，还没说**这个 Data Page 已经 durable 了**。

不过在继续跟着 Data Page 往下走之前，先处理一个很容易冒出来的疑问。

## WAL Flush 为什么不用再等一次 fsync

前面一直说 `Flush LSN >= Commit LSN` 以后，WAL 就可以相信了。到了 Data Page 这里，却要强调 `write()` 只是把数据交给文件系统，后面还得另外 `fsync()`。

WAL 难道不也经过文件系统和 kernel page cache 吗？

区别在 `Flush` 这个词本身。PostgreSQL 内部把 WAL 的两个进度分开记录：

```text
XLogwrtResult
    |
    +-- Write  已经 write 到文件系统的位置
    +-- Flush  已经完成持久化同步的位置
```

所以 `XLogFlush()` 并不是“把 WAL 写出去”这么简单，它要求目标 LSN 真正推进到 `Flush` 这个边界。`XLogWrite()` 负责把 WAL Buffer 写到文件，如果还需要同步，再调用 `issue_xlog_fsync()`。

具体怎么同步，由 `wal_sync_method` 决定：

```text
fdatasync        先 write，再 fdatasync()
fsync            先 write，再 fsync()
fsync_writethrough
open_datasync    WAL 文件以 O_DSYNC 打开
open_sync        WAL 文件以 O_SYNC 打开
```

区别主要在同步的范围：`fsync()` 连文件 metadata 一起落盘，`fdatasync()` 只保证读回文件内容所必需的部分（WAL 是追加写，通常够用，Linux 上默认就是它）；`O_SYNC` 类似 `fsync()`，`O_DSYNC` 类似 `fdatasync()`，`fsync_writethrough` 则额外要求写穿磁盘缓存。

`fsync`、`fsync_writethrough`、`fdatasync` 会分别走到 `pg_fsync_no_writethrough()`、`pg_fsync_writethrough()` 或 `pg_fdatasync()`；`open_datasync` 和 `open_sync` 在 `open()` 时已经把同步语义放进了 write 本身，`issue_xlog_fsync()` 直接返回。

实现可以不同，对上层的承诺是一样的：

```text
XLogFlush(0/500) 返回
        |
        v
0/500 以前的 WAL
已经跨过 PostgreSQL 要求的持久化边界
```

所以 WAL 不是不用管 `fsync`，而是**已经把它算进 Flush 里了**。“WAL Flush” 是 PostgreSQL 定义的一层语义，不等于某个固定的系统调用。

把两条路径放在一起看，差别就清楚了：

```text
WAL
    write --> sync --> Flush 完成
                         |
                         v
                    当场 durable

Data Page
    write --> kernel page cache
                  |
                  +-- 登记 sync responsibility
                            |
                            v
                     Checkpointer 以后再结账
```

同步 COMMIT 的语义本来就是：Commit Record 的 WAL 必须 durable，然后才返回。如果 `XLogFlush()` 也只写到 kernel page cache 就返回，那刚告诉客户端成功的事务，掉电以后仍然可能消失。

WAL 没有把 durability responsibility 推迟到 Checkpointer，是因为这里没有那个时间窗口：客户端正在等 `COMMIT`。它能做的优化不是延迟，而是合并——多个并发事务的 Commit LSN，可以由同一次 WAL sync 一起覆盖，也就是上一篇看到的 group commit。

这里默认 `fsync = on`，且事务走同步提交。`fsync = off` 时 PostgreSQL 不会强制 WAL 落到稳定存储；`synchronous_commit = off` 时，事务也不会停下来等自己的 WAL Flush。

## write() 返回以后，还差什么

回到 Data Page 这条线。`FlushBuffer()` 最终会把 Page 交给 Storage Manager。Buffer Manager 操作的是 `relation + fork + block number`，到了 `smgr` / `md.c`，才把它转换成实际文件。

因为一个 relation 在磁盘上并不天然对应一个文件。先有不同的 fork：

```text
main
fsm
vm
init
```

一个 fork 太大以后还会继续拆 segment，默认每个 relation segment 是 1GB。所以一个 block 最终大概经过：

```text
relation / fork / block
          |
          v
    segment number
    segment offset
          |
          v
      actual file
```

大表在目录里可能看到：

```text
base/16384/24576
base/16384/24576.1
base/16384/24576.2
```

Page 是按 block 修改的，但真正需要持久化的对象，最后落到了某个 relation segment 文件上。`mdwritev()` 完成文件写入以后，这些 bytes 已经离开 PostgreSQL 的 Shared Buffers，交给了操作系统。

问题就在这里。在普通 buffered I/O 下：

```text
write() success
```

并不能直接推出：

```text
data is on stable storage
```

它很可能还在 kernel page cache。如果现在只是 Backend 正常退出，没什么问题，内核以后还会继续把这些脏数据写出去；如果现在直接掉电，就不是一回事了。

所以 PostgreSQL 在 `write()` 完成以后，并没有把这个文件当成已经处理完。它又记了一笔账。

## 写完以后，留下一笔 Sync 责任

`md.c` 写完 relation segment 后，会走到 `register_dirty_segment()`。里面会构造一个 `FileTag`，可以先把它理解成：

```text
FileTag
  |
  +-- relation
  +-- fork
  +-- segment
  +-- sync handler
```

然后：

```c
RegisterSyncRequest(&tag, SYNC_REQUEST, false);
```

这一步没有继续写 Page，也没有立刻 `fsync()`。它只是告诉 PostgreSQL：这个文件被改过了，还有一笔 sync 责任没有完成。

我觉得这里是整条链里挺关键的一步。平时容易把 Page Flush 想成：

```text
Dirty Page
    |
    v
write()
    |
    v
done
```

PostgreSQL 实际上更接近：

```text
Dirty Page
    |
    v
write()
    |
    v
kernel page cache
    |
    +-- record sync responsibility
```

数据已经写了，责任还没有结束。

## 为什么记的是 Segment，不是 Page

假设一个 Backend 连续写了这些 Page：

```text
block 42
block 51
block 78
block 103
```

而它们都属于 `relation A / main fork / segment 0`。最终同步时，并不需要做：

```text
block 42  -> fsync
block 51  -> fsync
block 78  -> fsync
block 103 -> fsync
```

`fsync()` 面对的是文件。一次对 segment 文件的同步，可以覆盖此前针对这个文件的一批写入。

所以 Page 写回和最终持久化之间，粒度其实变化了一次：

```text
Buffer Manager
    | relation / fork / block
    v
md.c
    | relation / fork / segment
    v
sync layer
    | FileTag
    v
```

这也解释了为什么 `FileTag` 里关心的是 segment identity：写的时候，我们关心哪一页；同步的时候，我们关心哪一个文件还欠账。

## 这笔账为什么不能直接记一个 fd

继续看 `fd.c`，还有一层挺有意思。

PostgreSQL 代码里常见的 `File`，并不是 Unix fd。它更像当前 Backend 私有 `VfdCache` 里的一个索引：

```text
File
 |
 v
VfdCache[file]
 |
 +-- fileName
 +-- flags
 +-- mode
 +-- fd
```

真正的 OS fd 在里面。而且这个 fd 此刻甚至可能是关闭的。

一个 Backend 可能访问很多 relation segment、临时文件以及其他文件，不可能无限占用真实 fd，所以 `fd.c` 会做 VFD cache。文件暂时不用时，可以关闭 OS fd：

```text
logical file still exists
          |
          +-- OS fd may be closed
```

以后再次访问，再根据文件名和 flags 重新 `open()`。

这意味着 Backend A 手里的 `File` 或 fd，都不是一个适合跨进程传递的身份。Checkpointer 不能收到 `fd = 37`，然后就知道 Backend A 到底想让它同步什么——`37` 只对那个进程有意义。

所以当持久化责任准备从 Backend 转交给 Checkpointer 时，PostgreSQL 又回到了一个稳定的物理 identity：`relation + fork + segment`，也就是 `FileTag`。

这几层 identity 放在一起看挺有意思：

```text
Buffer Manager
    | relation / fork / block
    v
md.c
    | relation / fork / segment
    v
fd.c
    | backend-local File / fd
    v
sync request
    | cross-process FileTag
    v
Checkpointer
```

看源码时会觉得怎么同一个文件到处都有一种表示，真到了跨模块、跨进程交接责任的时候，它们各自的边界就比较清楚了。

## 为什么不让写 Page 的 Backend 顺手 fsync

最简单的实现当然是 `write()` 之后紧跟着 `fsync()`，谁写的谁负责到底。实现容易理解，前台性能就不好看了。

比如同一个 segment 很短时间内连续发生：

```text
write block 42
write block 51
write block 78
write block 103
```

如果每一次都跟着一次 `fsync()`，很多 I/O 等待其实是重复的。而从最终 durability 的角度，只要在合适的时间把这个 segment 统一同步一次，就能覆盖前面这一批写入。

所以正常情况下，Backend 做的是：

```text
Backend
   |
   +-- write page
   |
   +-- RegisterSyncRequest()
              |
              v
         Checkpointer
```

前台把“这个文件还需要同步”这件事交出去，然后继续工作。Checkpointer 收到请求以后，会把它们吸收到自己的 `pendingOps`。如果多个 Backend 都写了同一个 segment：

```text
Backend A -- block 42 --+
                        |
Backend B -- block 78 --+--> relation A / main / seg 0
                        |
Backend C -- block 91 --+
```

到了最终 sync 阶段，这些修改可以收敛成一条：

```text
relation A / main / seg 0
          |
          v
       needs sync
```

这里保存的与其说是一堆 I/O task，我觉得更像一组**还没有兑现的 durability responsibility**。

## 责任可以转移，但不能凭空消失

有个小细节特别能说明这件事。

`md.c` 登记普通 dirty segment 时调用：

```c
RegisterSyncRequest(&tag, SYNC_REQUEST, false);
```

这个请求正常情况下会进入 Checkpointer 的队列。但如果没有成功交出去，PostgreSQL 不能简单地：

```text
queue full

oh well
```

然后继续。调用方会自己完成同步。

也就是说，这里的正确性规则其实和“必须由 Checkpointer fsync”没太大关系。真正重要的是：

```text
somebody must own the sync responsibility
```

正常情况：

```text
Backend
   |
   +-- transfer responsibility
            |
            v
      Checkpointer
```

转交失败：

```text
Backend
   |
   +-- still owns responsibility
            |
            v
      fsync by itself
```

谁来做可以变化，但这笔责任不能没人管。

这种设计我挺喜欢：性能优化没有另外造一套 correctness 规则，只是允许责任在进程之间迁移，但任何时候都得知道现在是谁拿着它。

## 最后由 Checkpoint 来结账

这些 pending sync 最终会在 Checkpoint 汇合。

Checkpoint 平时经常被简单描述成“定期把 Dirty Page 刷到磁盘”。这个模型干活没有问题，但把 Crash Recovery 放进来后，还需要再补一句：Checkpoint 最终还要建立一个新的恢复起点。

假设最后得到 `Redo LSN = 0/1000`，未来数据库崩溃以后，可以从这里开始重放 WAL。这句话其实带着一个隐含条件：**`0/1000` 之前那些已经不准备重放的历史，对应的数据文件状态必须足够可靠。**

否则会发生一个很直接的问题。假设：

```text
WAL 0/900
    |
    +-- modified Page A
```

Checkpoint 最后告诉 Recovery 从 `0/1000` 开始，但是 Page A 只是 `write()` 到了 kernel page cache，还没有真正同步下来。这时候机器掉电，重启后磁盘上的 Page A 仍然是旧版本；Recovery 又从 `0/1000` 开始，`0/900` 那次修改已经在起点以前。前后就断开了。

因此 Checkpoint 里不仅有写 Dirty Buffer 的阶段，后面还有：

```text
write dirty buffers
        |
        v
collect sync requests
        |
        v
ProcessSyncRequests()
        |
        v
FileSync()
```

当前 PostgreSQL 的 `CheckPointGuts()` 在 Buffer 写出以后，会进入 `ProcessSyncRequests()`，处理这一轮需要完成的文件同步。

所以 Checkpoint 遇到 I/O 压力时，问题也不只是“要写多少 dirty page”，还有“还有多少个 dirty file 需要 sync”。Page Write 和 File Sync 是两个阶段，新的恢复边界要依赖后者真正完成。

## Data Page 到底什么时候可以相信

到这里再回答开头的问题，会发现它没有一个像 Commit LSN 那么干净的单点答案。

WAL 有一个很好理解的条件：`Flush LSN >= Commit LSN`，满足以后，这笔事务需要的恢复信息已经持久化。Data Page 不需要在 COMMIT 时达到同样的状态，它可以继续 dirty，也可以很晚才写回。

从一个 Page 的角度看，更像经过两个边界。第一个很熟悉：

```text
WAL for this page is durable
          |
          v
page is safe to write
```

第二个才是这篇真正想看的：

```text
page write
    |
    v
segment becomes dirty
    |
    v
sync responsibility recorded
    |
    v
file sync completed
    |
    v
checkpoint may rely on it
```

这里还需要注意一个边界。Checkpoint 也不是要求“到这个瞬间，数据库最新的所有 Data Page 都必须在磁盘上”。Checkpoint 进行过程中，业务还在运行，新的事务还会继续修改 Page、生成新的 WAL，这些发生在 Redo Point 之后的变化，本来就可以留给未来的 WAL Recovery。

Checkpoint 要保证的是另外一件事：

```text
              Redo Point
                  |
old WAL ----------+---------- new WAL
                  |
      data files can safely
      continue from here
```

也就是说：既然未来准备从这个 Redo Point 开始恢复，那么磁盘上的 Data File 必须能够从这里继续接住后面的 WAL。

这时候 WAL 和 Data Page 的两种“可信”就有点不一样了。事务提交关心的是“如果现在崩溃，这笔事务还能不能找回来”；Checkpoint 关心的是“如果以后从这个位置开始恢复，磁盘上的 Data File 能不能接得住”。

最后把整条路径压在一起，大概是：

```text
                 modify page
                     |
          +----------+----------+
          v                     v
      Dirty Page            WAL Record
          |                     |
          |                     v
          |                 WAL Flush
          |                     |
          |                     v
          |                  COMMIT
          |
          |    ... maybe much later ...
          v
     FlushBuffer()
          |
          v
        write
          |
          v
   relation segment dirty
          |
          v
 RegisterSyncRequest()
          |
          v
 Checkpointer pendingOps
          |
          v
 ProcessSyncRequests()
          |
          v
        fsync
          |
          v
new checkpoint recovery boundary
```

上一篇追的是：WAL 到什么位置以后，PostgreSQL 才敢告诉客户端 COMMIT 成功？这次顺着 Data Page 往下走，会发现它完全不用着急追上 WAL。WAL 先替它兜着。

Page 可以晚一点写，多个 Page 的写可以汇总到同一个 segment，同步责任也可以从 Backend 转交给 Checkpointer。WAL 和 Data Page 面对的是同一个 `write() != durable`，区别只在结账时间：同步提交要求这笔 WAL 的持久化责任在 COMMIT 返回前已经结清，它可能由别的 Backend 或 WAL Writer 提前完成，也可能和其他事务合并完成，但不能留到 COMMIT 返回以后；Data Page 则允许先把 sync 责任记下来，等 Checkpoint 把恢复起点往前推时再集中处理。

所以源码里的 `Now it's safe to write the buffer to disk.` 其实只是这段路的起点。从 **safe to write** 到 **safe to rely on**，中间还隔着一次责任交接和一次 `fsync()`。而 WAL 给 Data Page 留出来的，正是这段可以慢慢走完的距离。
