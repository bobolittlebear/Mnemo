# 长期记忆三层触发机制 — 实现方案（v3 终态版）

> 项目：Mnemo · 会话消息长期记忆管理模块  
> 技术栈：Node.js + Express + TypeScript + MongoDB + Redis  
> 前置依赖：`memoryPipelineService.run(sessionId)`（已实现增量提取全流程）+ STM 游标管理（已实现）  
> 版本说明：在 v2 基础上合并 D2/D3/D4/D5 四项**最终决策**，已落地的组件标注「已实现」。不含代码实现。

---

## 〇、v3 相对 v2 的核心变更

| 决策 | v2 状态 | v3 终态 | 影响范围 |
| ---------- | ----- | ---------- | ---------- |
| **D3 语义识别** | 待确认（原计划正则）      | **不实现，永不实现**   | L1 仅由 `endSession` 按钮触发；删除语义识别中间件           |
| **D4 锁续期** | 已确认不实现 | 维持不实现（原因细化） | 无代码改动 |
| **D4 processing 续期** | v2 计划 Pipeline 内部续期 | **不实现** | 仅保留 300s 基线；Pipeline 不感知 trigger 的 processing key |
| **D5 ENDING 中间态**   | 待确认 | **不实现** | 状态机退回 2 态；无 ending key，无前端联动 |
| **续聊语义** | 未定义 | **新增决策** | 终结后同 sessionId 续聊 = 视为新会话（元宝/千问式） |

> v2 的 7 项调整（processing 300s、术语统一、P3 重试、finally 兜底、级联清理、监控 P1）**全部保留**，本文不再重复列出。

---

## 一、架构概览

### 1.1 设计目标

| 目标 | 说明 |
| ----- | ---------- |
| **不丢** | 任何对话的记忆都能被提取，无论用户是否正常退出 |
| **不重** | 同一段对话历史只被提取一次，杜绝重复 LLM 调用和重复记忆 |
| **不卡** | 分布式锁不包裹长耗时 LLM 调用，避免同会话触发器互相饥饿 |
| **可幂等** | 终态标记保证所有触发器可安全重试，结果一致 |
| **可观测** | 核心指标埋点钩子已预留，后端待 Phase 5 落地 |

### 1.2 核心设计原则

1. **终态前置校验**：所有触发器在执行任何 LLM 调用前，必须且仅能通过检查 `memory:session:{id}:extracted` 终态标记决定是否继续
2. **终态不可逆**：标记一旦写入，在当前会话生命周期内不可清除（会话被「重新激活」时整体重置，见 §2.1）
3. **锁职责收窄**：锁仅保护「读终态 → 写终态 / 设标记」的临界区原子性，不包裹 LLM 调用
4. **Processing 标记防重**：短锁内设置 `processing` 标记，横跨无锁的 LLM 提取阶段，防止同会话并发提取
5. **第三层不写终态**：兜底触发仅做增量持久化，保留会话继续流转的可能性
6. **L1 单一入口**：显性触发**仅**由前端 `endSession` 按钮经 API 触发，**不做任何语义识别**（D3 已否决）

### 1.3 职责划分

| 组件 | 职责 | 状态 |
| ----- | --------------- | --------- |
| **MemoryTriggerCoordinator**（协调器） | 终态标记管理 + processing 防并发 + 分布式锁 + 三阶段编排      | ✅ 已实现 |
| **DistributedLock** | 分布式锁：`acquire` / `release`（Lua 原子） | ✅ 已实现 |
| **TerminalStateManager** | 终态标记：`isExtracted` / `markExtracted`（不可逆） | ✅ 已实现 |
| **ProcessingGuard** | 防并发标记：`trySet` / `clear` / `current`（TTL 300s） | ✅ 已实现 |
| **MessageCounter**（L3 接入） | per-session 消息计数，达阈值调 `coordinator.triggerThreshold` | ✅ 已实现 |
| **memoryPipelineService.run**（已有） | 读游标 → 取增量消息 → LLM 提取 → 向量化 → 存储 → 更新游标 | 已有 |
| **STM 模块**（已有） | `setLastExtractedMsgId` / `getLastExtractedMsgId` 游标管理 | 已有 |

协调器在 Phase 2 只做一件事：`await pipeline.run(sessionId)`。**游标数据归 STM 管理**（key + `get/setLastExtractedMsgId` 原语），Pipeline 仅作为调用方在提取流程中使用它，协调器不介入游标读写、不获取消息列表。**

---

## 二、三层触发职责

核心区分：**L1/L2 是终态写入者，L3 是增量持久化者**。L1 无其他自动触发路径（D3 已否决语义识别）。

| 层 | 触发条件 | 写终态？ | 提取方式 | 角色 |
| ----- | ---------- | ----- | ----- | ----- |
| **L1 显性** | 前端「结束/删除会话」按钮 → `endSession` API | 是（不可逆） | 增量收尾 | 实时关闭记忆窗口 |
| **L2 超时** | Cron 扫描 `last_active_at` 超时 | 是（不可逆） | 增量收尾 | 兜底安全网 |
| **L3 兜底** | 消息累积达阈值（如 20 轮） | **否** | 增量提取 | 阶段性存档，会话可继续 |

> **术语澄清**：L1/L2/L3 都调用 `pipeline.run(sessionId)`，提取范围由 cursor 决定，三者等价。区别仅在 Phase 3 是否写 `extracted` 终态标记。「增量收尾」= 提取 cursor 之后的全部剩余消息 + 写终态，不是「全量重提」。

### 2.1 会话终结后的续聊语义（v3 新增决策）

> 来源：用户决策 —— 与原对话（同 sessionId）在 `last_active_at` 超时、L2 自动提取并设终态后，用户若继续在该 sessionId 发消息，应视为**无记忆状态（即新会话）**。元宝、千问等主流 AI Chat 产品均如此设计。

**行为定义**：

1. L1/L2 写入 `extracted` 终态后，该 sessionId 的「记忆窗口」关闭。
2. 用户在**同一 sessionId** 继续发送消息 → 视为开启**新会话阶段**：
    - 会话上下文（STM / 工作记忆）重置，不注入上一阶段的对话上下文；
    - LTM 提取生命周期重启：重置 `cursor`、重置 `msg_count`、**清除 `extracted` 终态标记**，使 L3 可对新阶段消息重新触发；
    - 已提取的 LTM 仍作为**跨会话记忆**可被检索（检索层行为，不在触发机制职责内）。
3. 重置动作归属 **Session 生命周期管理服务**（在消息入库时检测 `extracted` 已存在即执行），**不是 Coordinator 职责**——Coordinator 只管「单次生命周期内的提取与终态」。

**设计意图**：同一 sessionId 被复用为「连续的新对话」，既符合用户心智（继续聊就是新话题），又避免终态标记永久阻塞后续提取。终端不可逆性限定在「单次生命周期内」，跨阶段复用由显式重置打破。

---

## 三、Redis Key 设计与完整生命周期

> processing TTL = 300s（v2 调整保留）。**v3 变更：删除 Pipeline 内部续期，processing 的「更新」列清空。**

### 3.1 四个 Key 总览

| Key | 用途 | TTL | 何时创建 | 何时更新 | 何时删除/过期 |
| ----- | ----- | ----- | ----- | ----- | ----- |
| `memory:session:{sid}:lock` | 分布式锁 | 10s | P1/P3 获锁时 `SET NX PX` | 不更新 | P1/P3 主动 `DEL`；崩溃则 10s 自动过期防死锁 |
| `memory:session:{sid}:processing` | 防并发标记 | **300s** | P1 步骤4 `SET NX PX` | **不更新** | P3 主动 `DEL`；P2 finally 块兜底 `DEL`；崩溃则 300s 自动过期 |
| `memory:session:{sid}:extracted` | 终态标记（不可逆） | = Session TTL | L1/L2 在 P3 步骤3 `SET`  | 永不更新 | Session 销毁 / 同 sessionId 续聊重置时 `DEL`；生命周期内不删 |
| `memory:session:{sid}:cursor` | 增量游标（已有） | = Session TTL | 首次提取前由 STM 创建 | P2 期间由 Pipeline 通过 `STM.setLastExtractedMsgId` 更新 | Session 销毁 / 同 sessionId 续聊重置时 `DEL` |

> **对比 v2**：processing 不再由 Pipeline 续期（见 §七 D4 决策）；`extracted` / `cursor` 的删除新增「续聊重置」触发点（见 §2.1）。

### 3.2 Key 生命周期时间线

```
时间轴 ──────────────────────────────────────────────────────────►

lock        ┌─P1获锁(10s)─┐                    ┌─P3获锁(10s)─┐
            │             │                    │             │
            └────DEL──────┘                    └────DEL──────┘
            <50ms                              <50ms

processing        ┌─SET(300s)─────────────────────────DEL────┐
                  │                                          │
                  │      （横跨 P2 无锁期，期间不续期）            │
                  │                                          │
                  └────────── 横跨P2无锁期 ──────────────────┘
                  P1设置                                      P3/finally清除

extracted                                                       ┌─SET(不可逆)─
                                                                │
                                                                └─── 存活至Session销毁/续聊重置 ──►

cursor          ┌─已有──────────────────Pipeline内部更新─────────────────────►
                │                                                        │
                └──────────────── 横跨整个Session生命周期 ────────────────►
```

### 3.3 关键设计洞察

**`processing` 横跨 P1→P2→P3 全程，比 `lock` 活得久。**

- `lock` 只在临界区短暂存在（P1 和 P3 各 <50ms），保护「读终态→写终态」的原子性
- Phase 2 的 LLM 提取耗时 10-30s 是**无锁**的——这段时间里，`processing` 标记替代了锁的防并发作用
- 其他触发器在 P1 看到 `processing` 已存在就直接 SKIP 返回，不空等锁

**为什么 processing TTL = 300s 且无需续期（D4 决策，详见 §七）**：当前 LLM 调用超时上限为 非流式 120s / 流式 30s，P2 总耗时（LLM + 向量化 + 存储）稳定在 300s 以内，300s 基线提供 >2× 余量。续期会让 Pipeline 耦合触发器（违背 D1），得不偿失。

---

## 四、三阶段处理流程

> 所有触发器（L1/L2/L3）统一走三阶段路径。

### 4.1 流程总览

| 阶段 | 持锁 | 耗时     职责 |
| ----- | ----- | ----- | --------------- |
| **Phase 1** | 短锁 | <50ms  | 获锁 → 终态校验 → processing 校验 → 设 processing → 释锁 |
| **Phase 2** | **无锁** | 10-30s | `await pipeline.run(sessionId)` — Pipeline 内部自动管游标 |
| **Phase 3** | 短锁 | <50ms  | 重新获锁 → 二次终态校验 → 写终态(L1/L2) 或无操作(L3) → 清 processing → 释锁 |

### 4.2 Phase 1 详细步骤（短锁）

```
P1-1  获取分布式锁 (SET NX PX 10s)
      ├─ 获锁失败 → SKIP_LOCK，直接返回，不空等
      │
P1-2  检查 extracted 终态标记
      ├─ 已存在 → SKIP_TERMINAL
      │   ├─ L3: 额外重置 msg_count（防止后续每轮空跑校验）
      │   └─ L1/L2: 幂等返回
      │
P1-3  检查 processing 标记
      ├─ 已存在 → SKIP_PROCESSING，返回不重入
      │
P1-4  设置 processing 标记 (SET NX PX 300s)
      │   值 = 触发层标识 (explicit/timeout/threshold)
      │
P1-5  释放分布式锁
```

### 4.3 Phase 2 详细步骤（无锁）

```
P2-1  await pipeline.run(sessionId)
      │   Pipeline 内部：读cursor → 取增量消息 → LLM提取 → 向量化 → 存储 → 更新cursor
      │   协调器不碰游标，不获取消息列表
      │
      ├─ 提取失败 → catch 块清除 processing → 抛出异常
      │
P2-2  （正常完成）进入 Phase 3
```

> **finally 块兜底**：无论 Phase 2 成功还是失败，finally 块都 best-effort `DEL processing`。P2 完成后 processing 的防并发使命已结束，即使 P3 没执行到清除步骤，finally 也保证清理。TTL 300s 是最终兜底。

> **v3 变更**：删除 v2 的「P2-2 Pipeline 内部续期」（D4 决策，见 §七）。

### 4.4 Phase 3 详细步骤（短锁）

```
P3-1  获取分布式锁（带重试）
      │   重试 3 次，间隔 1s（P3 本身 <50ms，重试总耗时最多 3s）
      ├─ 3 次全失败 → 依赖 finally 块已清 processing，返回 COMPLETED
      │              游标已由 Pipeline 更新，终态由 L2 Cron 兜底
      │
P3-2  二次检查 extracted 终态标记
      ├─ 已存在 → SKIP_TERMINAL（P2 期间另一个触发器已写终态）
      │           清除 processing → 释锁 → 返回
      │
P3-3  执行状态写入（在同一把锁内，保证原子性）
      ├─ L1/L2: 写 extracted 终态标记（不可逆）
      └─ L3: 无操作（游标已由 Pipeline 更新）
      │
P3-4  清除 processing 标记
P3-5  释放分布式锁
```

> **写入原子性保证**：P3 的「写 extracted + 删 processing」在同一把锁内完成，不会出现终态写了但 processing 没清的中间态。

### 4.5 为什么 Phase 2 不持锁

整个设计围绕一个矛盾展开：**锁不能包裹 LLM 调用（会阻塞饥饿），但又必须防止并发重复提取。**

解法是用两套机制分工：

- **分布式锁**：职责收窄，只保护「读终态→写终态」的临界区原子性，持锁 <50ms
- **processing 标记**：横跨整个提取过程，作为无锁期间的并发屏障，TTL 300s 兜底（不续期，理由见 §七）

两者配合，既不阻塞，又不重复——这就是三阶段流程存在的意义。

---

## 五、三道 SKIP 闸门

> 后到触发器必经三道闸门，任一拦截即返回，不空等锁、不重入提取。

| 闸门 | 触发条件 | 行为 | 设计意图 |
| ----- | ----- | ----- | ----- |
| **SKIP_LOCK** | P1/P3 获锁失败 | 直接返回，不等待 | 避免空等锁导致请求堆积 |
| **SKIP_TERMINAL** | `extracted` 已存在  | 幂等返回（终态已写） | 终态不可逆，后续操作无意义 |
| **SKIP_PROCESSING** | `processing` 已存在 | 返回（他人正在提取） | 防止同会话并发 LLM 调用 |

**闸门执行顺序**：P1 中按 `LOCK → TERMINAL → PROCESSING` 依次检查，短路退出。最便宜的 Redis GET 优先，最贵的等待锁最后。

---

## 六、并发场景处理

### 6.1 四个典型并发场景

| 场景 | 先到状态 | 后到触发器 | 拦截闸门 | 最终结果 |
| ----- | ----- | ----- | ----- | --------------- |
| L3 提取中 + L1 到达 | L3 在 P2, processing 存在 | L1 显性    | SKIP_PROCESSING | L1 重试，L3 完成后 L1 写终态，LLM 1 次 |
| L1 已完成 + L2 扫描 | extracted 已存在          | L2 超时    | SKIP_TERMINAL   | L2 幂等返回，移出扫描队列，LLM 0 次    |
| L1 提取中 + L3 到达 | L1 在 P2, processing 存在 | L3 兜底    | SKIP_PROCESSING | L3 直接退出重置计数器，L1 完成写终态   |
| L3 提取中 + L2 扫描 | L3 在 P2, processing 存在 | L2 超时    | SKIP_PROCESSING | L2 跳过本轮，下轮再查，LLM 0 次        |

**共性**：后到触发器在 P1 闸门即被拦截，不进入 P2，不空等锁，不重复调用 LLM。

### 6.2 L1 SKIP 后的重试策略（D2 决策，已同意）

当 L1（显性触发，即 `endSession` 被点击）返回 `SKIP_PROCESSING` 时，必须确保终态最终被写入：

| 层级 | 策略 | 时机 | 兜底目标 |
| ----- | --------------- | ---------- | ----- |
| 同步重试  | 轮询等待 + 重试 3 次，间隔 5s  | 首次 SKIP 后立即开始   | L3 释放 processing 后进入 |
| 异步兜底  | 30s 后异步重试 1 次 | 同步重试仍 SKIP 时触发 | 覆盖 L3 临界超时 |
| 隐性兜底① | `processing` TTL 300s 自然过期 | 所有显式重试失败时     | 会话重新可被终结 |
| 隐性兜底② | L2 Cron 扫描 | 每日安全网 | 终态最终一定写入 |

**多次重试全失败的兜底结论**（回应「若多次重试均不成功」）：

即使同步重试 + 异步兜底**全部失败**，仍有两道隐性兜底——`processing` 标记 300s 自然过期使会话重新可终结，L2 Cron 作为每日安全网确保终态**最终一定写入**。

最坏情况（服务宕机 + Cron 也挂）：会话「终结」状态延迟到服务恢复，但**记忆数据不丢**（L3 已增量持久化，用户可继续对话）。不构成数据损坏。

---

## 七、锁与 Processing 续期决策（D4 细化）

### 7.1 锁自动续期 —— **不实现**

**原因**：Phase 2 无锁，锁只在 P1 / P3 临界区（纯 Redis 状态读写，<50ms）短暂持有。续期机制针对「长持锁」场景，本设计无适用对象。引入续期需看门狗/心跳，扩大崩溃面，与「无锁、无状态管理负担」哲学冲突。

**影响**：极小。P1/P3 是毫秒级 GET/SET/DEL，Redis 正常不可能超 10s TTL；即使极端抖动超 TTL，processing 的 NX 语义仍是第二道防线，不会双写终态。

### 7.2 Processing 续期 —— **不实现，300s 基线足够**

> 用户疑问：300s 是否足以覆盖 LLM 超时？是否需要像 v2 计划的那样由 Pipeline 内部续期？

**结论：300s 基线单独足够，不实现续期。** 分析如下。

**(1) 300s 为什么够 —— 基于当前超时配置**

| 调用类型 | LLM 超时上限 | P2 总耗时估算 | 余量 |
| ----- | ----- | ---------- | ----- |
| 非流式 | 120s | ≤ 135s（LLM + 向量化/存储 ~15s） | 300s = 2.2× |
| 流式 | 30s | ≤ 45s | 300s = 6.7× |

P2 总耗时稳定 < 300s，processing 不会在提取完成前过期。

**(2) 增量窗口天然封顶 P2 时长**

L3 每 20 轮触发一次，因此任何一次终端触发（L1/L2）处理的增量窗口 ≤ 20 轮（自上次提取以来）。单窗口内的消息被 1-2 次 LLM 调用覆盖，不会因会话极长而无界膨胀。

**(3) 续期不做的理由**

- **耦合代价**：Pipeline 续期需 Pipeline 感知 trigger 的 `processing` key，违背 D1「pipeline 只编排提取、不感知触发器」。
- **崩溃面**：在 Pipeline 内嵌续期定时器增加复杂度与故障点。
- **收益不足**：300s 已覆盖当前全部场景，续期只是防御「LLM 超时被调到 >250s」的极端未来，不值得现在付耦合成本。

**(4) 其他需考虑的方面（已纳入约束）**

| 考虑点 | 结论 |
| ----- | -------------------- |
| **LLM 超时配置上调**  | 必须维持不变式：`processing TTL (300s) ≥ 2 × maxLLMTimeout + overhead`。建议启动时用配置断言校验，防止上调 LLM 超时后忘记配套调整 TTL |
| **多实例 TTL 一致性** | TTL 在 Redis 服务端，跨实例一致，无漂移。安全 |
| **Redis 内存淘汰** | 极端内存压力下 LRU 可能提前逐出 processing key（体积小，低概率）。即使发生 → 可能双重提取，但终态幂等 + cursor 前移保证不会产生重复记忆（P3 二次校验拦截）。可接受 |
| **Pipeline 分批处理** | 若未来 Pipeline 改为多批顺序 LLM 调用，单窗口总耗时仍 ≤ 批数 × 120s，但会因 L3 每 20 条消息封顶而不膨胀。不变式仍成立 |

**最终约束（写进配置）**：

```
processingTtl (300s) ≥ 2 × llmTimeoutMax (120s) + overhead (~60s)
```

若 `llmTimeoutMax` 未来上调超过 ~120s，优先**调大 processingTtl**，而非引入续期。

---

## 八、Session 销毁级联清理

在 Session 销毁的 hook 中，级联清理该 Session 的全部 4 个 Redis Key（`lock` / `processing` / `extracted` / `cursor`）。另见 §2.1：同 sessionId 续聊重置时，`extracted` 与 `cursor` 也需被清除。

**优先级**：P2（低优）。TTL 设对即自动过期，显式删除属运维卫生。

---

## 九、监控埋点（钩子已预留，后端待 Phase 5）

> 三个核心指标已在 Coordinator 内以 `metrics?.count(...)` 钩子预留，不传 metrics 即 no-op。独立 Metrics 后端**暂缓生成**（D3 决策会中未决议，列为后续优化 O3）。

| 指标 | 反映什么 | 异常意味着 |
| ----- | ---------- | --------------- |
| **processing 超时次数** | LLM 提取耗时 > TTL 的频率 | 不变式被破坏或 LLM 服务异常（见 §7.2 约束）                        |
| **P3 重试次数**         | P3 获锁失败的概率         | Redis 抖动或锁竞争激烈                                             |
| **SKIP 闸门命中分布**   | 并发竞争实况              | SKIP_PROCESSING 高 = 并发激烈；SKIP_TERMINAL 低 = 终态写入可能异常 |

> **设计意图**：SKIP 闸门命中分布是验证并发模型是否符合预期的唯一手段。后端落地后上线第一周重点观察。

---

## 十、会话状态机（v3 退回 2 态，无 ENDING）

### 10.1 状态定义

| 状态 | 含义 | 允许的操作 | 转换条件 |
| ----- | ----- | --------------- | ---------- |
| `ACTIVE` | 会话进行中，可接受所有触发 | 增量提取、增量收尾 | 初始状态 |
| `EXTRACTED` | 会话记忆已终结（L1/L2 写入） | 仅允许读取/查询 | L1/L2 成功写入终态 |
| （重置） | 同 sessionId 续聊 | 重启整个生命周期   | EXTRACTED + 新消息到达（见 §2.1） |

### 10.2 状态转换

```
ACTIVE ──(msg_count ≥ 20 条消息)──► [L3 增量提取] ──► ACTIVE (继续)
  │
  ├──(endSession 按钮)──────► EXTRACTED   ← L1 写终态
  │                                    ▲
  └──(Cron 超时 last_active_at)──────►┘     ← L2 写终态

EXTRACTED + 同 sessionId 新消息 ──(Session 生命周期服务重置)──► ACTIVE (新阶段)
```

> **D5 已否决 ENDING**：不引入第三中间态。原因——会话级 LTM 提取的是事实/偏好等摘要，用户无需感知「我们正在保存记忆」，这是额外信息。当前两态机制已正确终结会话，ENDING 属体验增强而非正确性必需。

### 10.3 Redis 标记状态组合

| extracted | processing | 含义 | 可执行操作 |
| ----- | ----- | ---------- | ---------- |
| absent | absent | 空闲，可触发 | 任意触发器可设置 processing |
| absent | threshold | 兜底层正在增量提取 | L1/L2 等待或 SKIP；L3 SKIP |
| absent | explicit/timeout | 终态层正在增量收尾 | 所有其他触发器 SKIP |
| present | * | 终态已写入 | 所有触发器幂等返回（续聊重置除外，见 §2.1） |

---

## 十一、决策状态汇总（v3 终态）

| 编号 | 决策点 | 结论 | 关键理由 |
| ----- | ----- | ---------- | ---------- |
| **D1**  | 游标归属 | 已确认（自动解决）   | 协调器不碰游标，Pipeline/STM 管理 |
| **D2**  | L1 SKIP 后重试 + 多次失败兜底 | **已同意** | 同步重试 3×(5s) + 异步 30s + processing 300s 过期 + L2 Cron，终态最终必写入 |
| **D3**  | 语义识别方案 | **不实现，永不实现** | 正则不准、LLM 太慢；已有 endSession 按钮更优；续聊视为新会话由 L2 兜底 |
| **D4**  | 锁自动续期 | **不实现** | Phase 2 无锁，锁仅护 <50ms 临界区，续期无适用对象 |
| **D4'** | processing 续期 | **不实现**           | 300s 基线 >2× LLM 超时(120s)，余量充足；续期耦合 Pipeline 违背 D1 |
| **D5**  | ENDING 中间态 | **不实现** | 用户对「保存记忆」无感知需求，属体验增强非正确性必需 |

---

## 十二、后续优化方向 list（v3 修订）

> 记录决策过程中明确需后续优化的点。D3 相关项（O1 语义识别、LLM 两阶段精判）**已随 D3 否决一并作废**。

| 编号 | 优化点 | 当前状态 | 优先级 |
| ----- | ---------- | ---------- | ----- |
| O2 | 锁持有时长监控 | D4 不实现续期；建议监控 `ltm.lock.hold.ms`，异常增长再启用续期 | P3 |
| O3 | 监控埋点后端 | Coordinator 钩子已预留，独立后端暂缓生成 | P1（后端） |
| O4 | processing TTL 不变式校验 | §7.2 约束：启动配置断言 `ttl ≥ 2×llmTimeout+overhead` | P2 |
| O5 | L3 阈值 20 硬编码 | 应可配置化（不同会话/用户差异化） | P3 |
| O6 | L1 重试固定间隔盲试 | 改为事件驱动（等 processing 清除事件再重试） | P2 |
| O7 | Cron 全量扫描性能 | 大会话量下应增量扫描 / 索引 `last_active_at` | P3 |
| O8 | 多实例下 key TTL 与 Session TTL 对齐 | 需配置中心统一管理，防止错配 | P2         |
| O9 | 终态写入后历史消息清理策略 | 未定义（可选压缩/归档） | P3 |
| **O10** | **续聊重置归属与实现** | §2.1 已决策语义，具体由 Session 生命周期服务实现（检测 extracted + 新消息 → 重置 cursor/msg_count/extracted） | P2 |

> 已作废项：原 O1 语义识别误判/漏判、原 §2.4 LLM 两阶段精判 —— 随 D3 否决移除。

---

## 十三、实现顺序与状态
	
> 状态：✅=已完成  ⬜=待做
> 重要区分：「组件实现」(写类) 与「接入调用/接线」(在应用流程中调用) 是两个阶段。
> 当前所有 trigger 组件已实现，但 L1/L2/L3 的接入调用均未做。

```
Phase 1: 基础设施（✅ 已完成）
      ├── DistributedLock            ✅
      ├── TerminalStateManager       ✅
      ├── ProcessingGuard            ✅
      └── 单元测试                    ✅（组件级）

Phase 2: 核心协调器（✅ 已完成）
      ├── MemoryTriggerCoordinator   ✅（三阶段 + finally 兜底 + triggerThreshold + executeTerminalTrigger）
      └── 并发集成测试                ✅

Phase 3: 触发器组件（✅ 已完成实现，待接入）
      ├── messageCounter (L3)        ✅ 组件
      ├── sessionEndTrigger (L1)     ✅ 组件（end）
      ├── sessionTimeoutScanner (L2) ✅ 组件（scanOnce/start/stop）
      ├── sessionMemoryLifecycle     ✅ 组件（destroy / resetForContinuation）
      └── memoryTriggerConfig        ✅ 组件（含 validateConfigInvariants，已在 import 时调用）

Phase 4: 接入调用 / 接线（⬜ 待实现，功能测试前置）
      ├── L3 接入：chatStream.service.persistConversation 落库后，fire-and-forget 调用
      │            messageCounter.record(memoryKey)（不 await；record 内部已 catch）
      ├── L1 接入：chat.controller.endSession / chatHistoryService.endSession 内
      │            await sessionEndTrigger.end(memoryKey)（与现有 STM.clearSession 并列，不替换）
      ├── L2 接入（含阻塞项）：
      │     ├─ 实现 InactiveSessionStore.findInactiveSessions（数据源见下方「L2 数据源决策」）
      │     └─ app.ts 在 app.listen 前调用 sessionTimeoutScanner.start()
      ├── 销毁 hook 接入：chatHistoryService.clearAll 内调用 sessionMemoryLifecycle.destroy(memoryKey)
      └── 续聊重置接入(O10，可延后)：chatStream.service.persistConversation 开头调用
                  sessionMemoryLifecycle.resetForContinuation(memoryKey)，返回 true 时消息服务重置 STM 短期上下文

Phase 5: 功能测试（⬜ 待实现，接入后执行）
      ├── L3：连续发 21 条消息 → 验证 msg_count 达阈值触发 triggerThreshold、终态未写、会话可继续
      ├── L1：点 endSession → 验证 extracted 写入、幂等(重复点击=200)、L2 扫描跳过
      ├── L2：构造超时会话 → 验证 executeTerminalTrigger('timeout') 写终态（依赖 Phase 4 数据源）
      ├── 并发：L1 与 L3 同发 → 验证仅 1 次 LLM 调用、零重复记忆
      └── 续聊：EXTRACTED 后同 memoryKey 续聊 → 验证 resetForContinuation 清 4 key、新阶段重新触发 L3

Phase 6: 压力测试与监控（可选 / 暂缓）
      ├── 与 memoryPipelineService 联调压测
      └── 监控后端接入（O3，Coordinator 埋点钩子接真实 Metrics）
```
