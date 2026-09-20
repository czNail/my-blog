---
author: Neil Chen
pubDatetime: 2026-09-20T00:00:00+08:00
title: Checkpoint 调优，到底在调什么？
description: Checkpoint 引起的 I/O 尖峰和延迟抖动，可能来自触发太频繁，也可能来自某一轮写得太重。把一次 Checkpoint 拆成 trigger、write、sync 三段，再顺着 WAL、pg_wal 和 Recovery 往下看，这几个参数各自管什么就清楚了。
tags:
  - postgresql
  - internals
---

# Checkpoint 调优，到底在调什么？

上一篇把 Checkpointer、BgWriter 和 WAL Writer 放在一起看了一遍。

写到这里，这个 PostgreSQL 内核系列稍微拐个弯。

前面的文章大多在追一个机制：PostgreSQL 为什么这样设计，状态怎么流转，Crash 之后又怎么把数据接回来。这一篇换个视角，看看前面讲过的这些内核机制到了真实系统里会表现成什么问题，又能怎么指导调优。

Checkpoint 很适合做这个尝试。

它一头连着 Dirty Page、WAL 和 Recovery，另一头又直接出现在 DBA 经常遇到的问题里：

```text
周期性的 I/O 尖峰
P99 延迟抖动
WAL 突然变多
pg_wal 越来越大
Crash Recovery 太慢
```

所以这篇不打算把几个参数挨个解释一遍，也不继续沿源码调用链往下走。

还是从一个实际问题开始。

假设某天下午，监控变成了这样：

```text
P99 Latency

                     /\
                    /  \
-------------------/    \----------------
                                  /\
                                 /  \
--------------------------------/    \----


Disk Write

                 ███████
-----------------███████-----------------
                              ███████
------------------------------███████-----
```

差不多每隔几分钟来一次。

翻一下日志，时间又刚好和 Checkpoint 对得上。

这时几个参数很容易一起冒出来：

```text
checkpoint_timeout
max_wal_size
checkpoint_completion_target
checkpoint_flush_after
```

到底该动哪个？

我现在更习惯先看：**这次 Checkpoint 的成本到底落在哪一段。**

位置找对了，参数反而好理解。

## 来得太勤，还是每次太重？

Checkpoint 和延迟毛刺同时出现，先把两种情况分开：

```text
                    Checkpoint
                        |
            +-----------+-----------+
            |                       |
            v                       v
       来得太频繁？              每次都太重？
            |                       |
            v                       v
       为什么总触发？            慢在哪里？
```

如果每轮都很平滑，只是几分钟就来一次，先查触发频率。

如果半小时才跑一次，但每次一来磁盘就打满、P99 就抖，那就跟着这一轮 Checkpoint 往下看。

两种现象最后都可能被归结为“Checkpoint 影响性能”，处理方式却完全不同。

先看频率。

## 为什么 Checkpoint 总来？

自动 Checkpoint 最常见的两个触发来源，是时间和 WAL。

时间这边比较直接：

```text
时间到了
    |
    v
checkpoint_timeout
    |
    v
Checkpoint
```

另外一边是 WAL：

```text
WAL 持续产生
      |
      v
可用的 WAL 预算越来越紧
      |
      v
Checkpoint
```

所以发现 Checkpoint 很频繁时，我一般不会先改参数，而是先看看这段时间到底发生了什么。

PostgreSQL 17 才开始有独立的 `pg_stat_checkpointer`；`num_done` 是 PG18 才加的。下面以 PG18 为例：

```sql
SELECT
    num_timed,
    num_requested,
    num_done,
    write_time,
    sync_time,
    buffers_written
FROM pg_stat_checkpointer;
```

先看几个计数：

```text
num_timed
    因 checkpoint_timeout 调度的 Checkpoint

num_requested
    由请求触发的 Checkpoint
    （WAL 压力、手工 CHECKPOINT 等）

num_done
    真正执行完成的 Checkpoint
```

`num_timed` 和 `num_requested` 把完成的、跳过的都算了进去，`num_done` 才是真正执行的次数。`num_timed + num_requested` 和 `num_done` 对不上，说明有些 Checkpoint 最后被跳过，并没有真正执行。典型的情况是系统自上一轮以来一直空闲。

如果长期主要是 `num_timed` 在增长，`checkpoint_timeout` 自然值得关注。

如果 `num_requested` 增长很快，就要继续找是谁在请求：WAL 超过 `max_wal_size` 会算在这里，手工执行 `CHECKPOINT` 也会。所以 `num_requested` 多，并不能直接等同于 `max_wal_size` 太小。

不过在持续写入的数据库里，WAL 压力通常更值得优先排查。

接下来更值得问的是：

> 当前 workload 到底以多快的速度在产生 WAL？

### 4GB 的 max_wal_size，到底算大还是小？

假设两套数据库都配了 `max_wal_size = 4GB`：

```text
系统 A： 5 MB WAL/s
系统 B： 200 MB WAL/s
```

同样的 4GB，意义完全不同：

```text
                4GB WAL 预算

系统 A
|------------------------------------------|

系统 B
|-----|
      很快就吃完
```

PostgreSQL 内部当然不是简单地拿 `max_wal_size / WAL 生成速率` 来决定下一次 Checkpoint。

但这个除法很适合建立容量上的直觉。

它把“`max_wal_size` 到底应该配多大”这个难回答的问题，换成了另一个更容易讨论的问题：

> 按照当前 WAL 的生成速度，这份 WAL 预算大概能撑多久？

平时系统可能只有 10MB/s WAL。

来一次批量 `COPY`、大批量 UPDATE 或数据导入，WAL 生成速率突然升到 300MB/s，同样的配置就可能表现得完全不同。

如果日志里还频繁出现 Checkpoint 过近的告警，`max_wal_size` 和当前 workload 是否匹配就更值得检查：

```text
LOG:  checkpoints are occurring too frequently (18 seconds apart)
HINT:  Consider increasing the configuration parameter "max_wal_size".
```

到这里，频率问题大概可以收成这样一张图：

```text
Checkpoint 太频繁
        |
        +--> 时间主导
        |      |
        |      v
        | checkpoint_timeout
        |
        +--> WAL / request 主导
               |
               v
          WAL 生成速率
          max_wal_size
          其他 request 来源
```

如果 Checkpoint 次数其实没什么异常，那就该看另一边了：

**为什么每一轮都这么重？**

## 跟着一次 Checkpoint 往下走

上一篇已经把 Online Checkpoint 的机制讲过了。

调优时不用再把完整源码重新过一遍，只保留和性能有关的部分：

```text
确定本轮 redo point
        |
        v
+-------------------+
|    write phase    |
|                   |
| 写本轮 Dirty Page |
+-------------------+
        |
        v
+-------------------+
|    sync phase     |
|                   |
| 确保文件 durable  |
+-------------------+
        |
        v
checkpoint record
pg_control 更新
        |
        v
新的 Recovery 边界正式可用
```

所以“Checkpoint 很慢”还能继续拆：是 write 慢，还是 sync 慢？

后面的分析，就从这里分岔。

## 第一站：短时间是不是写了太多 Page？

假设这一轮最后要写 10GB Dirty Page。

如果用了 200 秒，平均就是 `10GB / 200s ≈ 51MB/s`，磁盘看到的大概是：

```text
▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
-------------------------------->
```

如果集中在 20 秒，平均会到 `10GB / 20s ≈ 512MB/s`，就更像：

```text
            ████████
------------████████-------------------->
```

最终写出去的数据量没有变化。

差别在于，同样一批 I/O 被摊在了多长的时间里。

这也是理解 `checkpoint_completion_target` 比较直观的方式。

### completion_target：别急着把这一轮写完

Checkpoint 开始以后，PostgreSQL 不会看到一批 Dirty Page 就按照磁盘极限速度一口气写完。

Checkpoint write 本身有 pacing。

简单画一下：

```text
当前 Checkpoint                         下一次
|------------------------------------------|
^                                      ^
|                                      |
开始                               目标完成附近

      <------- 尽量把写入摊开 ------->
```

`checkpoint_completion_target` 控制的，就是尽量利用 Checkpoint interval 的多大一部分来完成写入，默认值是 0.9。

如果把完成时间压得很短：

```text
▂▂▂▂▂▂▂▂▂▂
```

就会逐渐变成：

```text
████████
```

Checkpoint 确实更早结束了，但 Checkpointer 和前台业务也更容易在短时间内争抢存储。

所以看到“Checkpoint 一来，Disk Write 就冲高”，我会先把三个量放在一起：

```text
这一轮写了多少？
        |
        v
buffers_written


用了多久？
        |
        v
write_time


底层存储稳定能写多少？
        |
        v
Storage Throughput
```

比如一轮 Checkpoint 写了 12GB、持续 180 秒，平均也就六七十 MB/s。如果底层设备稳定能跑几百 MB/s，这个数字本身未必有什么问题。

反过来，如果同样 12GB 几十秒就写完，而存储稳定写能力只有 200MB/s，业务本身还在大量做 I/O，延迟被一起带起来就很正常了。

这里也能看到 `checkpoint_completion_target` 的边界：

> 它可以调整 I/O 的节奏，不能增加磁盘带宽。

存储已经长期接近饱和时，再怎么微调 Checkpoint pacing，也很难解决根因。

## 第二站：write 很平滑，为什么最后还是卡一下？

再换一种情况。

整个 Checkpoint 期间：

```text
Disk Write

▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
----------------------------->
```

看起来都正常。

可到了尾部：

```text
P99 Latency

                         █████
-------------------------█████
```

这时就该往后看 `sync phase` 了。

上一篇已经讲过，`write()` 和 `durable` 之间还有距离。

很多时候 Data Page write 先到的是操作系统：

```text
Shared Buffers
      |
      v
   write()
      |
      v
OS Page Cache
```

从 Shared Buffers 的角度看，这次 write 已经完成。

但存储设备还没有承诺数据一定可靠落盘。

Checkpoint 最后还得把这笔账收掉：

```text
OS Page Cache
      |
      v
fsync / fdatasync
      |
      v
Storage
```

于是可能出现：

```text
PostgreSQL 一路 write
        |
        v
OS Dirty Pages
████████████████████████

最后
        |
        v
      fsync
        |
        v
   Storage Flush
```

前面没有消失的成本，最后集中暴露出来。

`pg_stat_checkpointer` 正好把两段时间拆开：

```sql
SELECT
    write_time,
    sync_time,
    buffers_written
FROM pg_stat_checkpointer;
```

如果主要是 `write_time` 高，重点继续留在 Dirty Set、Pacing 和 Storage Write Bandwidth。

如果 `sync_time` 很突出，问题就开始往 OS Writeback、fsync latency 和 Storage Flush latency 移动。

还有一点要注意：这些都是累计统计。排查时要看一段时间里的增量，或者结合单次 Checkpoint 的日志，而不是拿从上次 reset 到现在的总数直接比较。

### checkpoint_flush_after 为什么会出现在这里？

理解前面的链路以后，这个参数就没那么抽象了。

如果 PostgreSQL 一直 write、write、write，OS Page Cache 里的 Dirty Data 会越积越多：

```text
OS Dirty

████████████████████████████
```

最后 fsync 时，就可能出现比较明显的尾部压力。

`checkpoint_flush_after` 的思路，是在写到一定程度以后，提前推动操作系统把一部分 Dirty Data 往下写：

```text
████
   ↓
writeback

       ████
          ↓
       writeback

              ████
```

而不是一直积到：

```text
████████████████████████
                       |
                       v
                    fsync
```

Linux 上它的默认值是 256kB，其他平台默认 0；0 表示关闭强制回写。Linux 上的实现最终是通过 `sync_file_range()` 请求内核回写。

这个参数也不是越积极越好。

一些 workload 本身能很好地利用 OS Page Cache，过早推动 writeback 反而可能影响性能。

所以最好等确认 sync / writeback 确实是主要问题以后再考虑。

到这里，一轮 Checkpoint 自己的性能问题基本就能定位了：

```text
为什么来得这么勤？       -> Trigger
为什么这一轮写得这么重？ -> Write
为什么尾部又卡了一下？   -> Sync
```

不过 Checkpoint 调优还有另一半。

你可以把 Checkpoint 自己调得更轻，却不代表这些成本真的消失了。

## Checkpoint 变少，WAL 也会跟着少吗？

先看 `full_page_writes`。

前面讲 WAL Record 时已经见过 FPI：新的 Checkpoint 周期开始以后，一个 Page 第一次被修改时，为了防止 Partial Page Write 带来的恢复问题，通常需要在 WAL 里记录 Full Page Image。

所以：

```text
Checkpoint
     |
     v

Page A 第一次修改 -> FPI
Page B 第一次修改 -> FPI
Page C 第一次修改 -> FPI
Page D 第一次修改 -> FPI
```

随着越来越多热点 Page 已经经历过这一周期的第一次修改，后面 FPI 的密度通常会慢慢降下来。

如果 workload 本身比较稳定，FPI 带来的那部分额外 WAL 往往更集中在 Checkpoint 之后；总的 WAL 生成速度是否真的呈现这条曲线，还要看业务自己的写入：

```text
Checkpoint
    |
    v

████████
██████
████
██
█
-------------------------->
```

这样一来，Checkpoint 频率和 WAL 之间就形成了联系：

```text
Checkpoint 更频繁
        |
        v
新的 FPI 周期更频繁
        |
        v
FPI 增多
        |
        v
WAL 增多
        |
        v
WAL 预算消耗更快
```

所以为了缩短 Recovery 而把 Checkpoint 调得很频繁，正常运行期间的 WAL 成本也可能跟着增加。

可以看：

```sql
SELECT
    wal_records,
    wal_fpi,
    wal_bytes
FROM pg_stat_wal;
```

调整 Checkpoint 参数以后，比起只看“Checkpoint 次数少了多少”，我更愿意把 Checkpoint 频率、`wal_fpi` 和 `wal_bytes` 放在一起比较。

否则很容易只看到一边。

## Checkpoint 拉长以后，Recovery 会怎么样？

既然频繁 Checkpoint 会增加正常运行成本，那很自然会考虑把 `checkpoint_timeout` 和 `max_wal_size` 往上调。

Checkpoint 少一点以后：

```text
Checkpoint 频率 ↓

FPI 周期切换 ↓

日常 Checkpoint 干扰可能下降
```

但 Checkpoint 还有一个职责：建立新的 Recovery 边界。

Crash 后，大致需要从可用的 redo point 往后 replay：

```text
redo point                           WAL end
    |                                  |
    v                                  v
----X----------------------------------X
    |<--------- WAL Replay ----------->|
```

Checkpoint 拉得更远，这段 Recovery 需要处理的 WAL 也可能变长。

所以“正常运行更轻”的另一面，可能就是“Crash Recovery 做更多工作”。

这时候就没办法只讨论数据库参数了，业务对恢复时间的要求也会参与进来。

例如：

```text
系统 A
Crash 后 30 秒必须恢复


系统 B
Crash 后几分钟可以接受
但在线交易延迟希望尽量稳定
```

两套系统的 Checkpoint 策略自然不会一样。

上一篇讲 Online Checkpoint 时还留下一个细节，在这里也有用。

这一轮新的 redo point 很早就确定了：

```text
new redo point
     |
     v
write...
     |
     v
sync...
     |
     v
checkpoint 完成
     |
     v
新的 Recovery 入口正式可用
```

如果 Checkpoint 中途 Crash：

```text
上一轮成功 Checkpoint
        |
新的 Checkpoint
        |
        | write...
        |
      CRASH
```

新的 Checkpoint 还没有完成，不能直接把它当成新的恢复入口。

所以除了 Checkpoint 的间隔，一轮 Checkpoint 自己拖多久，也会影响崩溃时能退回到哪个已经完成的恢复边界。

## pg_wal 很大，也是 Checkpoint 的问题吗？

讲到 WAL 空间，很容易遇到另一个问题：

```text
/pg_wal = 80GB
```

然后第一反应往往是：是不是 `max_wal_size` 配太大了？

但 `max_wal_size` 从来都不是 `/pg_wal` 的硬上限。

Checkpoint 推进以后，只说明从 Crash Recovery 角度看，一部分旧 WAL 已经不再需要。

一个 WAL Segment 最后能不能回收，还要看有没有其他地方需要它：

```text
                  这段旧 WAL 能删吗？
                          |
        +-----------------+-----------------+
        |                 |                 |
        v                 v                 v
    Recovery          Replication        Archive
     还需要？          Slot 还需要？      完成了吗？
```

例如 replication slot 还停在很老的位置：

```text
Replication Slot
        |
        v
--------X------------------------------------> Current WAL
        |
        |<----- 这些 WAL 还得留着 --------->|
```

Checkpoint 已经很正常，这些 WAL 仍然不能回收。

停下来查一下：

```sql
SELECT slot_name,
       active,
       restart_lsn,
       pg_size_pretty(
           pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
       ) AS wal_retained
FROM pg_replication_slots;
```

类似地，`wal_keep_size`、归档延迟、Replication Slot 都会影响 WAL 的保留时间。

所以这里最好把两个看起来很像的问题拆开：

```text
为什么 WAL 产生得这么多？
        |
        v
Workload
FPI
Checkpoint 频率


为什么旧 WAL 还没有回收？
        |
        v
Recovery
Slot
Archive
wal_keep_size
```

两边最后都会表现成“WAL 很多”，排查方向却完全不同。

## 把整条链放在一起

现在再回到最开始那几个参数：

```text
checkpoint_timeout
max_wal_size
checkpoint_completion_target
checkpoint_flush_after
```

它们其实分别站在不同的位置上。

```text
                  Checkpoint
                      |
             为什么来得这么频繁？
                      |
          +-----------+-----------+
          |                       |
       timeout                WAL / request
          |                       |
          v                       v
 checkpoint_timeout      max_wal_size / WAL 生成速率

                      |
                      v
               一轮 Checkpoint 开始
                      |
          +-----------+-----------+
          |                       |
          v                       v
        write                    sync
          |                       |
   Dirty Set / Pacing       OS Writeback
   Write Bandwidth          fsync latency
          |                       |
          v                       v
 completion_target            flush_after

                      |
                      v
               Checkpoint 完成
                      |
               后面还有几笔账
                      |
          +-----------+-----------+
          |           |           |
          v           v           v
      WAL / FPI   WAL 空间    Recovery
```

前半段关注的，是这一轮 Checkpoint 自己发生了什么。

后半段关注的，是 Checkpoint 频率和持续时间变化以后，WAL、空间和 Recovery 跟着发生了什么。

到这里，几个参数之间的关系基本就能放进同一张图里了。

## 调优之前，先给这些成本定个预算

走到这里，`checkpoint_timeout` 应该大还是小，`max_wal_size` 应该给多少，已经很难脱离业务单独回答了。

更实际的是先给几笔成本定个范围。

比如：

```text
正常运行
    P99 延迟最多能接受多少波动？

存储
    Checkpoint 可以长期占多少写带宽？

WAL
    /pg_wal 愿意准备多少磁盘空间？

Recovery
    Crash 后希望多久恢复？
```

这几项目标往往没法同时做到最好。

如果在线延迟最重要，就可能愿意让 Checkpoint 用更长时间慢慢写，也愿意为更长的 Checkpoint 周期多留一些 WAL 空间。

如果 RTO 很严格，希望 Crash 后尽快恢复，那恢复边界就不能长期停在很老的位置，相应地要接受更频繁的 Checkpoint，以及可能更多的 FPI 和正常运行 I/O。

如果磁盘空间本来就紧张，`max_wal_size`、Replication Slot 和归档延迟又不能只从性能角度考虑。

最后调的其实是几笔预算之间的关系：

```text
        Checkpoint 间隔、pacing、单轮范围
                      |
        +-------------+-------------+
        |             |             |
        v             v             v
   日常 I/O 抖动   WAL 生成量   WAL 磁盘占用
        |             |             |
        +-------------+-------------+
                      |
                      v
             Crash Recovery 时间
```

Checkpoint 很难把其中哪一项成本直接消掉。

更多时候是在决定：这笔成本现在付多少、什么时候付，是留在正常运行里，还是留给 Crash Recovery。

理解了 Checkpoint 的内核机制以后，这几个参数也就不像一套需要背下来的“最佳配置”了。

它们决定的只是这几笔账在什么时间、以什么节奏结账。
