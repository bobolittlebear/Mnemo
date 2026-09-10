# Mnemo 记忆遗忘机制 v1 方案设计

> 本文档覆盖旧的 v2.1 双轨稿。v1 是 v2.1 的严格子集 + 复活修复，废弃了 trustScore / relevanceScore 双轨打分。

## 0. 读者画像与设计目标

- 读者：你（评审）+ 未来实现者。预设你已知 LTM 全链路（提取→入库→检索→选择）、`MemoryFact` 模型、`deletedAt` 软删约定、`contentHash` 唯一索引。
- 目标：有效（清掉真正无用的记忆）+ 可靠（绝不误删重要记忆、绝不冷启动清空库）。
- 硬约束：单用户、零生产数据、无 CI、必须复用既有 `deletedAt` 与 `contentHash`，不新增基础设施。
- 运行环境：个人开发环境起本地服务，无正式 / 预发 / 生产环境，无「发布」「上线」流程；所有验证在开发环境手动完成。

## 1. 架构与数据流

### 架构（三层）

- 信号采集层：3 个 `lastSignificantAt` 写入点（检索命中 / 入库 / 提取 UPDATE），记录记忆「最后一次被实质使用」的时间。
- 判定层：离线路径 `scripts/forget-memories.ts`，backfill → 按 category 扫描 → 四条件 AND → 软删。
- 与 LTM 关系：判定层只产出「软删 / 不软删」布尔，不产 rank 信号；排序全交 A0/A1/B/hardMax；软删复用既有 `deletedAt` 与 `contentHash`。

### 数据流

```
用户消息
   │
   ▼
memorySearch.service.search(userId, query)
   │ 返回 MemorySearchResult[]（RRF 已融合，max 10 条）
   │
   ├─[写入点1·副作用] fire-and-forget updateMany
   │     lastSignificantAt = now（vectorScore ≥ 0.5 的候选，按 24h 刷新，不阻塞响应）
   │
   ▼
memorySelection.service.select(results, config)
   │
   ├─ A0: vectorScore 绝对地板（语义相关性门卫）
   ├─ A1: 百分位截断（长尾噪声兜底）→ 空集兜底
   ├─ B: 查询 embedding → 贪心去重（重复保留更长者）→ 降级保护
   ├─ 硬上限：最终条数截断
   │
   ▼ 返回 MemorySelectionOutput { selected, metadata }
   │
   ▼
调用方将 selected 格式化为 system prompt 片段 → 注入 LLM

scripts/forget-memories.ts（手动触发，非热路径）
   │
   ├─ backfill：lastSignificantAt 为空的记忆 → = createdAt（防冷启动清空）
   ├─ 按 category 循环扫描（仅 9 个可删类，阈值从短到长）
   ├─ 四条件 AND 判定
   │     !deletedAt ∧ (now - lastSignificantAt > 阈值[category])
   │       ∧ confidence < 0.7 ∧ category ∉ NEVER_DELETE
   │
   ▼
软删：deletedAt = new Date()（复用既有软删字段，不真删记录）
   │
   ▼
下次 search 自动 filter deletedAt → 记录不进候选池（候选池收缩）

写入点2（入库）  memoryIngestion.service.ts upsert $set: lastSignificantAt = now
写入点3（提取）  memoryPipeline.service.ts UPDATE 分支 $set: lastSignificantAt = now

软删记录 ──(search 已 filter deletedAt)──▶ 不进入 MemorySearchResult[]
                                          ⇒ 到不了 A0 / 选择层 / 注入
```

### 与 LTM 现有三段的关系

- 检索→选择→注入（热路径）：写入点 1 挂在 `search()` 之后，异步副作用，改库不改返回结果，下游 A0/A1/B 无感；软删在热路径之外，靠 `search` 的 `deletedAt` 过滤自然生效——遗忘不拦截单条请求，只收缩候选集合。
- Phase 1 短锁触发：遗忘不新增锁 / 触发器。短锁管「记忆提取」，写入点 3 只是提取 UPDATE 分支里一行 `$set`，吃既有 trigger 基础设施；判定层脚本独立进程，连 trigger 都不碰。
- ACTIVE/EXTRACTED 状态转换：会话 `ACTIVE→EXTRACTED`（L1 按钮或 L2 超时）触发提取 / 更新 → 写入点 2/3 刷新 `lastSignificantAt`，活跃对话天然续命相关记忆；但过期判定只看 `lastSignificantAt` 天数 + category 阈值，与 session 状态无关。

## 2. 核心模型：单字段 lastSignificantAt

整条机制只新增一个时间戳字段，不引入任何打分字段。

- 定义：`lastSignificantAt` = 该记忆「最后一次被实质使用」的时间。使用 = 被检索命中（见 §3）或被写入（入库 / 更新）。
- 落地：在 `src/models/MemoryFact.ts` 的 `deletedAt` 字段下方加 `lastSignificantAt: { type: Date }`。除索引外无其它 schema 改动。
- 为何不复用 `updatedAt`：`updatedAt` 反映「最后一次写入」，而检索命中是「读」、不触碰文档。一个被频繁召回但内容未变的记忆，`updatedAt` 永远是旧值，会把「常用记忆」误判为 stale。必须用独立字段区分「写时间」与「用时间」。
- **MemoryFact 类型说明（遗忘作用域）**：`MemoryFact` 是单集合多类型存储，`type` 字段取 `'fact' | 'note_chunk' | 'media'`（`MemoryFact.ts:29-33`），且 `category`（`:34-50`）、`confidence`（`:25`）对所有类型均为必填。遗忘机制**只针对 `type: 'fact'`**——`note_chunk` / `media` 由各自子系统（笔记 RAG / 媒体）管理，不在 LTM 遗忘范围内。本方案所有扫描查询与标记写入均显式加 `type: 'fact'` 过滤，避免误删非 fact 记忆。

## 3. "已使用"的标记：三个写入点

**全部 fire-and-forget，失败只 warn，不阻塞响应链路。**

- 写入点 1（检索路径，主信号）：`memorySearch.service.ts` 的 `search()` 在 `rrfFusion` 返回后，收集 `vectorScore >= MEMORY_SELECTION_MIN_VECTOR_SCORE`（0.5，即 A0 地板，常量在 `config.ts`）的候选 `_id`，执行：  
  `updateMany({ _id: { $in: ids }, type: 'fact', lastSignificantAt: { $not: { $gte: nowMinus24h } } }, { $set: { lastSignificantAt: new Date() } })`，不 await 响应路径。
  - 工程要求：必须写成 `void updateMany(...).catch((e) => logger.warn('forget-mark-failed', e))`。未 await 的 Promise 若不加 `.catch`，Node >=15 下未捕获 reject 会直接崩进程。
  - 运行时假设：依赖长驻 Node 进程（响应返回后进程仍存活足够久完成写入）。若部署在 serverless / edge（响应结束即冻结实例），写入点 1 的更新会静默丢失，退化为主信号缺失；此类形态需改为 await + 短超时或队列化。开发环境（本地长驻进程）满足该假设。
  - 写放大优化：filter 用 `lastSignificantAt: { $not: { $gte: nowMinus24h } }`（`nowMinus24h = new Date(Date.now() - 86_400_000)`，即滚动 24 小时窗口，无时区依赖），把「按次刷新」降为「按 24h 刷新」——对天级粒度的遗忘判定无精度损失，单用户下省写明显。选用 `$not` 而非 `$lt: startOfToday` 的关键原因：`$lt` 等比较算子对**缺失字段不命中**，而存量记忆在 backfill 之前可能尚无该字段——若用 `$lt`，首次被检索命中的存量记忆会因 filter 不命中而保持缺失，随后 backfill 把它设为 `createdAt`（很老），同次脚本运行即被误判为「很久未用」软删（N1 误删窗口）。`$not: { $gte: nowMinus24h }` 同时命中「缺失 / null / 早于窗口」三种情况，彻底消除该窗口。
  - **标记阈值**：复用 `MEMORY_SELECTION_MIN_VECTOR_SCORE` 保证「标记 ⊇ 注入」一致；在 `config.ts` 该常量处加注释声明其双重用途（标记阈值绑定 A0 地板），未来调 A0 地板会同步影响标记面，属已知耦合。
- 写入点 2（入库）：`memoryIngestion.service.ts` 的 upsert `$set` 内加 `lastSignificantAt: new Date()`。
- 写入点 3（提取 UPDATE）：`memoryPipeline.service.ts` 的 UPDATE 分支 `$set` 内加 `lastSignificantAt: new Date()`。
- 写入点 2/3 均为 fact 写入 / 更新路径，天然限定 `type: 'fact'`，无需额外过滤；与 §5 扫描、写入点 1 的 `type: 'fact'` 过滤保持一致。

## 4. 遗忘判定：四条件 AND

四个条件全部满足才软删，任意一条不成立即保留。

```
待删 = !deletedAt
    ∧ (now - lastSignificantAt > FORGET_INACTIVE_DAYS[category])
    ∧ confidence < FORGET_CONFIDENCE_FLOOR
    ∧ category ∉ FORGET_NEVER_DELETE
```

**per-category 不活跃天数阈值**（`instruction` / `preference` 因进 `NEVER_DELETE`，阈值在判定中被跳过，保留仅为枚举完整）：

| category         | 不活跃阈值（天）    | 语义依据            |
| ---------------- | ----------- | --------------- |
| event            | 14          | 事件类易过时          |
| instruction      | 30（实际不自动删）  | 用户指令，靠显式 DELETE |
| preference       | 120（实际不自动删） | 用户偏好，靠显式 DELETE |
| behavior_pattern | 120         | 行为模式较稳定         |
| skill            | 120         | 技能较稳定           |
| personal_info    | 180         | 长期有效，重新入库即重置    |
| relationship     | 180         | 关系长期有效          |
| goal             | 60          | 目标有时效           |
| decision         | 60          | 决策有时效           |
| diet             | 30          | 习惯多变            |
| other            | 14          | 未知信息价值低         |

**其余参数**（集中在 `config.ts`）：

- `FORGET_CONFIDENCE_FLOOR = 0.7`：低置信 = LLM 自己都不确定是不是真事实，这种才该清。
  - 锚点：提取侧 `memoryExtraction.service.ts:111` 已过滤 `confidence < 0.6` 的记忆（`if (fact.confidence < 0.6) continue`），即**入库记忆的 confidence 最低就是 0.6**。因此 0.7 的实际删除面是 **[0.6, 0.7) 这一窄区间**——专门收割「入库时 LLM 就只是勉强过线、自己都不太确定」的边界记忆；≥0.7 的记忆 LLM 相对有把握，误删代价上升，保留。该值仍为经验初值，零生产数据下无法证明 0.65 或 0.75 更优，待真实分布出来后集中改 `config.ts` 校准。
- `FORGET_NEVER_DELETE: MemoryCategory[] = ['instruction', 'preference']`：用户显式告知的偏好与指令，错删代价极高，排除在自动删除之外，移除仍走显式 DELETE（`memoryPipeline.service.ts` 的 DELETE 分支）。

### 为何在过期阈值之外还需置信度闸门

**过期阈值衡量「还有没有用」（时效性），置信度衡量「本身可不可信」（事实可靠性），二者正交**。只用过期阈值会误删「陈旧但确定的事实」；只用置信度会误删「新鲜但不确定」的记忆（其 age 还很小、根本超不了阈值，由过期阈值天然挡住）。二者 AND 把删除面收敛到唯一安全区——「既陈旧又不可信」。

- 例 A：「用户母语是中文」conf 0.95，半年没聊到 → age 超 `personal_info` 的 180 天，但 conf 0.95 拦截 → 保留（长期有效事实）。
- 例 B：「用户这周可能想换工作」conf 0.6，60 天未被强化 → age 超 `goal` 的 60 天且 conf < 0.7 → 删除（既陈旧又不可信的猜测）。

| 组合       | 处理结果 | 理由               |
| -------- | ---- | ---------------- |
| 陈旧 + 高置信 | 保留   | 长期有效的事实，错删代价高    |
| 新鲜 + 低置信 | 保留   | age 未超阈值，给系统验证时间 |
| 新鲜 + 高置信 | 保留   | 既可靠又新，显然是资产      |
| 陈旧 + 低置信 | 删除   | 既陈旧又不可信，机制唯一安全删除区 |

该闸门与 `NEVER_DELETE` 构成双层保护：高置信陈旧记忆永不自动清理，是设计的保守面而非缺陷（见 §11）。

**与选择层切分**：遗忘层只输出「软删 / 不软删」布尔，不产出任何 rank 信号。排序 100% 交给既有 A0/A1/B/hardMax，零耦合。

## 5. 执行器：手动脚本 + 安全护栏（无 cron / 无 CI）

复用评测 runner 的 `scripts/` + `dotenv` + `connect` 惯例，手动触发。开发环境直接 `ts-node scripts/forget-memories.ts` 运行。

`scripts/forget-memories.ts`：

1. 连接 DB（`scripts/check-indexes.ts` 同惯例）。
2. 冷启动 backfill：对 `type: 'fact'` 且 `lastSignificantAt` 为空的记忆，`updateMany` 设 `lastSignificantAt = createdAt`——让其从真实创建日龄化，而非从现在突然变老。（仅 fact 参与遗忘，`note_chunk` / `media` 不纳入）
3. 按 category 循环扫描（仅遍历 9 个可删类；顺序按阈值从短到长：`event→other→diet→goal→decision→behavior_pattern→skill→personal_info→relationship`），每个类跑一次 `find`：
   ```json
   {
     userId,
     type: 'fact',
     category,
     deletedAt: { $exists: false },
     lastSignificantAt: { $exists: true, $lt: cutoff(cat) },
     confidence: { $lt: FORGET_CONFIDENCE_FLOOR }
   }
   ```
   - 硬保底（回应「不得删除缺字段记忆」）：`lastSignificantAt: { $exists: true }` 保证没有该字段的记忆永远不会进入候选——即使 backfill 被跳过也安全。backfill 只是给它们一个真实日龄，不是删除的前提。
4. 删除上限（P1-2）：全局单一上限 `FORGET_MAX_DELETES_PER_RUN = 50`。category 按阈值从短到长遍历，先消耗预算者先删；报告按 category 分桶展示拟删数，便于人工判断预算分配是否合理。
5. 默认 dry-run（P1-3）：任何一次运行默认只打印候选数与样本内容，不写库；仅显式传入 `--execute` 才执行软删。无需持久化「是否首跑」状态。
6. 输出报告：扫描总数 / 各 category 候选数 / 已删（或拟删）数 / 样本内容，供人工复核。**dry-run 报告展示全量候选数（暴露积压规模），并标注「本次执行将受 `FORGET_MAX_DELETES_PER_RUN = 50` 上限截断」；`--execute` 时实际删除封顶 50，预览与实际行为一致。**

**索引：新增复合索引支撑按用户 + 类别扫旧记忆。**

```ts
MemoryFactSchema.index({ userId: 1, type: 1, category: 1, lastSignificantAt: 1 });
```

- 落地方法（Atlas + autoIndex 关闭）：项目 db 配置 `autoIndex:false`，索引不会随应用启动自动创建。需在 `MemoryFact.ts` 声明上述索引后，运行 `pnpm setup:indexes`（该脚本执行 `setup/setup-db-indexes.ts`，内部调用 `MemoryFact.syncIndexes()`）手动同步到 Atlas。改模型后必须重跑该命令。
- 写入点 1 的 `updateMany({ _id: { $in } })` 走 `_id` 索引，无需新索引支撑。

## 6. 复活：复用 contentHash 唯一索引

同一内容重现即复活，零新机制。

- `memoryIngestion.service.ts` 的 upsert：软删记忆被重新提取时，清除删除标记并刷新时间戳，形如：
  ```ts
  updateOne(
    { userId, contentHash },
    {
      $set: { /* content, confidence, ..., */ lastSignificantAt: new Date() },
      $unset: { deletedAt: "" }
    },
    { upsert: true }
  )
  ```
  - `$set` 与 `$unset` 在同一阶段操作不同字段是合法的；但切勿把 `deletedAt` 同时写进 `$set`（会与 `$unset` 同字段冲突报错）。
  - **复活后的 confidence 来源**：upsert 由「重新提取」触发，本次提取会产出**新的** `confidence` 并随 `$set` 写入，因此复活记忆带的是本次提取的置信度，而非被删时的旧低分。下一轮是否再次进入候选，取决于新 confidence 与阈值的比较——这是有意行为，非默认副作用。
- 选用 `$unset` 而非 `$set: { deletedAt: null }` 的理由：项目所有读路径（`memorySearch.service.ts:236/297`、`memoryPipeline.service.ts:131`）统一用 `deletedAt: { $exists: false }` 判定「未删除」。若复活写成 `$set: { deletedAt: null }`，`null` 是个值，会使 `exists:false` 读路径永远排除该记忆，复活失效。`$unset` 让字段回到「缺失」状态，与既有约定一致，无需改动任何读路径。
- 入库 filter 是 `{ userId, contentHash }`（不含 `deletedAt` 排除），upsert 会命中软删记录；`$unset` 后该记录重新被 `exists:false` 读路径包含，即完成复活。语义正确：相同内容再次出现 = 这条记忆又活了。

## 7. 全局约定：deletedAt 算子（项目级）

（P0-1 修复的文档载体，全项目必须遵守）

- 已删除 = `deletedAt` 字段存在且为非 null 值（软删写入 `new Date()`）。
- 未删除 = `deletedAt` 字段缺失。**全项目禁止向 `deletedAt` 写入显式 `null`**——清除删除标记一律用 `$unset`，不得用 `$set: { deletedAt: null }`（见下条）。显式 `null` 会使 `exists:false` 读路径永久排除该记录，与「未删除」定义相悖，是 复活失效 Bug 的温床。
- 所有读路径过滤未删除记录，必须用 `{ deletedAt: { $exists: false } }`。
- 复活清除删除标记，必须用 `$unset: { deletedAt: "" }`，禁止用 `$set: { deletedAt: null }`。
- 实施前审计清单第一项：确认 search / selection / 提取前查重 / 未来任何查询的 `deletedAt` 过滤算子均为 `$exists: false`，且与复活 `$unset` 一致。
- 审计清单第二项（`$type:10` 归零检查）：`MemoryFact.countDocuments({ deletedAt: { $type: 10 } })` 必须为 0（`$type:10` 是 BSON Null 类型，精确匹配显式 `null`；不可用 `{ deletedAt: null }` 查，它会同时命中缺失文档而误报）。若非 0，先 `updateMany({ deletedAt: { $type: 10 } }, { $unset: { deletedAt: "" } })` 归一化后再上线。

## 8. 参数汇总表

| 常量                                | 默认值                          | 章节      | 用途                                   |
| --------------------------------- | ---------------------------- | ------- | ------------------------------------ |
| MEMORY_SELECTION_MIN_VECTOR_SCORE | 0.5                          | §3 / §4 | A0 地板；同时作为写入点1标记阈值（双重用途）             |
| FORGET_INACTIVE_DAYS              | 见 §4 表                       | §4      | per-category 不活跃天数阈值                 |
| FORGET_CONFIDENCE_FLOOR           | 0.7                          | §4      | 低置信才清                                |
| FORGET_NEVER_DELETE               | ['instruction','preference'] | §4      | 排除自动删除的类                             |
| FORGET_MAX_DELETES_PER_RUN        | 50                           | §5      | 单次运行软删全局上限                           |
| 标记刷新粒度                            | 滚动 24h（nowMinus24h）          | §3      | 写入点1 刷新 lastSignificantAt 的窗口（N1/N3） |
| 检索返回上限                            | 10（search max）               | §1 图    | RRF 融合后候选条数                          |
| 选择硬上限                             | 8（hardMax）                   | §1 图    | 注入最终条数                               |

## 9. 实施与验证顺序（开发环境）

无正式环境，以下步骤均在本地开发环境手动完成，无「发布」「上线」环节。

实施步骤：

1. 模型加字段 + 声明索引：`MemoryFact.ts` 加 `lastSignificantAt` 字段与 `{ userId, category, lastSignificantAt }` 索引。
2. 同步索引：`pnpm setup:indexes`（Atlas，autoIndex 关闭，必须手动跑）。
3. 部署三个写入点：重启本地 dev 服务，使 search / 入库 / UPDATE 开始打 `lastSignificantAt`。
4. 跑遗忘脚本（自动 backfill + 默认 dry-run）：`ts-node scripts/forget-memories.ts`。
5. 人工复核 dry-run 报告：按 category 分桶的拟删样本，确认无重要记忆误入。
6. 确认无误后 `--execute` 真删。

最小手工验证清单（6 条）：

- backfill 幂等：重复跑不改变已存在 `lastSignificantAt`。
- dry-run 不写库：不加 `--execute` 时 `deletedAt` 无变化。
- 删除上限生效：构造 >50 候选时实际删除封顶 50。
- 软删记录不出现在 search：`deletedAt` 有值后 search 结果不含它。
- 同 contentHash 重新入库能被 search 召回（直接验证 P0-1 修复：复活走 `$unset` 后 `exists:false` 读路径重新包含）。
- 无 `lastSignificantAt` 的存量记忆被 search 命中后字段被正确写入（而非保持缺失等 backfill）：验证 N1 修复——`$not` filter 命中缺失字段，避免 backfill 把它设成旧 `createdAt` 后误删。

成功判据：每次 `--execute` 后抽样复核拟删样本内容；若后续出现复活事件（upsert 命中软删记录），记 log 作为误删信号观测。

## 10. 已知局限

- 高置信度陈旧记忆不自动清理：`confidence >= 0.7` 的记忆无论多 stale 都保留（四条件 AND 的正确保守面），且方案无合并 / 去重 / 总量控制机制。**矛盾事实（「住北京」conf 0.9 → 搬家后「住上海」）依赖提取管线的 UPDATE/DELETE 分支正确处理，遗忘层无兜底**。
- 常用记忆自我强化效应：常聊话题的记忆持续被标记续命，冷门但偶有价值的记忆只能靠入库时 `confidence >= 0.7` 保护（这类似 rich-get-richer / 马太效应：频繁出现的越强、少出现的越弱）。这是单信号模型的固有代价，`confidence` 地板正是为此设的，逻辑自洽，无需改。
- **软删记录保留在库中，可经 `contentHash` 复活；如需彻底清除（如用户注销）需另行处理。**
- contentHash 精确匹配复活的漏失：复活依赖 upsert filter `{userId, contentHash}`，而 contentHash 是对原始 content 字符串的哈希（`memoryIngestion.service.ts:40`、`memoryPipeline.service.ts:232` 均 `generateContentHash(fact.content)`）。同一事实语义相同但 LLM 提取时表述不同（概率模型，表述会漂移），哈希即不同，旧软删记录不会被命中，成为「幽灵记录」：带 deletedAt，不进候选池、不影响检索，但永不再被复活，库里累积死数据。该漏失真实存在但危害极低——幽灵记录不影响检索质量，单用户量级下数据增长可忽略，矛盾事实仍由提取 UPDATE/DELETE 分支处理，不依赖复活。
- **未来增强候选（v1 不实现）：语义复活兜底 / 梦境整理。**&#x4E8C;者都针对「contentHash 精确匹配无法覆盖语义同义」的问题，方向相反、互补而非二选一：
  - 语义复活兜底（优先）：记忆提取结束后，用新记忆 embedding 在软删池（deletedAt 存在）做向量相似度检索，超阈值（如 0.92）则视为同一记忆，执行 `$unset` 复活而非新建。实现最轻——复用已有 embedding 与向量检索，无定时任务，在提取链路即时完成。**前瞻注记：语义命中意味着新旧 content 表述不同，复活不能只 `$unset`——须同步 `$set` 新的 `content` / `contentHash` / `embedding`；而新 `contentHash` 可能撞 `(userId, contentHash)` 唯一索引（同义新表述的哈希恰等于另一条活跃记忆），需提前定义冲突时的合并 / 放弃策略，否则写入会失败。**
  - 梦境整理（暂缓）：夜间定时全量扫描软删池，逐条向量检索语义相近的「未删除记忆」，相似度极高则该软删记忆是冗余，可直接物理清除（purge），解决幽灵累积。但夜间全量 + 海量向量检索是耗时任务，且单用户下幽灵无害、增长可忽略，purge 价值低，暂缓。
  - 结论：**v1 维持 contentHash 精确复活，语义同义漏失以「幽灵无害」接受**；待真实数据证明漏失率或死数据量需处理时，优先上语义复活兜底（成本最低、收益最直接），梦境 purge 视数据规模再定。

## 11. 已拍板决策

| 决策              | 结论                                       |
| --------------- | ---------------------------------------- |
| 整体形态            | 单字段 lastSignificantAt + 四条件 AND 软删，无打分轨道 |
| per-category 阈值 | 采用，压平为扁平查表                               |
| NEVER_DELETE    | instruction / preference                 |
| 标记粒度            | A0 地板 0.5 命中即标记，防饿死                      |
| 执行方式            | 纯手动脚本 + dry-run，不加 scheduler             |
| P0-1 修复         | 选 B：$unset 复活 + 保留 exists:false 读路径      |
| P2 三项           | 全进 v1（P2-1 注释 / P2-2 索引 / P2-3 按天刷新）     |
| 环境假设            | 个人开发环境，无发布 / 上线，手动验证                     |

> 编号溯源（脱离评审上下文仍自解释）：
>
> - P0-1：复活用 `$set:{deletedAt:null}` 会使 `exists:false` 读路径永久排除该记忆，复活失效；选 B 用 `$unset` + 保留既有读路径。
> - P2-1：标记阈值复用 A0 地板常量，存在「调 A0 即影响标记面」的已知耦合，已在常量处注释。
> - P2-2：索引改为 `{userId, type, category, lastSignificantAt}` 贴合扫描查询（含 type 等值过滤）；autoIndex 关闭下靠 `pnpm setup:indexes` 手动同步。
> - P2-3：写入点1 加 filter 降为按天刷新省写；本轮已并入 N1 修复（`$not` + 滚动 24h）。
> - N1：写入点1 原用 `$lt:startOfToday` 不匹配缺失字段 → backfill 把「缺失（受保护）」变「存在且很老（可删）」→ 误删当天刚被使用的记忆；改 `$not: { $gte: nowMinus24h }`（滚动 24h）同时命中缺失 / null / 早于窗口三种情况。
> - N2：全局约定原文「未删除 = 字段缺失或显式 null」与「读路径 `exists:false`」自相矛盾（`exists:false` 不匹配 null）；收紧为「未删除 = 字段缺失，禁止写显式 null」，清除一律 `$unset`。
> - N3：`startOfToday` 时区未定义（依赖运行环境 TZ）；并入 N1 改用滚动 24h 窗口（`now - 86_400_000`），无时区概念。

## 12. 与现状的关系（清理项，非设计内容）

- 移除 `config.ts` 残留旧方案 F1 常量（`FORGETTING_HALF_LIFE` 半衰期表、`FORGETTING_STRONG_SIGNAL_*`、`FORGETTING_BOUNDARY_*`、`FORGETTING_RELEVANCE_*`、`REVIEW_MODEL` 仲裁）；删除已存在的 `src/services/memory/forgetting/scoring.ts`。
- `memoryPipeline.service.ts` 的 `deletedAt` 软删保留：LLM 显式 DELETE 指令，正确行为，与自动遗忘是两个写入源、互不冲突。
