# LTM 记忆选择策略实现方案（终版）

## 1. 模块位置与职责

**新增** `src/services/memory/memorySelection.service.ts`

职责：对 RRF 融合后的候选记忆做后置过滤/去重，输出最终注入 LLM 的记忆列表及过滤元数据。不碰检索逻辑，不碰 Prompt 拼装。

定位：**噪声兜底 + 多样性保障**——百分位截断是兜底去噪手段而非质量选择器，语义去重是多样性保障而非聚类算法。RRF 粗排仍是质量排序的主裁判。

**输入**：`MemorySearchResult[]`（来自 `memorySearch.service.search()`，每项含 `rrfScore` 和 `vectorScore`）
**输出**：`MemorySelectionOutput`（含 `selected` 子集 + `metadata` 过滤过程数据）

## 2. 数据流

```
用户消息
    │
    ▼
memorySearch.service.search(userId, query)
    │ 返回 MemorySearchResult[]（RRF 已融合，max 10条）
    ▼
memorySelection.service.select(results, config)
    │
    ├─ A0: vectorScore 绝对地板（语义相关性门卫，拦均匀噪声）
    ├─ A1: 百分位截断（长尾噪声兜底）→ 空集兜底
    ├─ B: 查询 embedding → 贪心去重（重复时保留更长者）→ 降级保护
    ├─ 硬上限：最终条数截断
    │
    ▼ 返回 MemorySelectionOutput { selected, metadata }
    │
    ▼
调用方将 selected 格式化为 system prompt 片段 → 注入 LLM
```

## 3. Pipeline A — 两级噪声过滤

### A0 — 绝对分数地板（语义相关性门卫）

**目标**：拦截"候选集中没有任何一条记忆与查询语义相关"的场景（均匀噪声），这是百分位截断无法应对的。

**为什么必须用 vectorScore 而非 rrfScore**：

| 维度 | vectorScore（余弦相似度） | rrfScore（排名融合分） |
|---|---|---|
| 尺 | 绝对尺，语义距离，0–1，跨查询可比 | 相对尺，候选集内哪个更好，0–0.033，不跨查询可比 |
| 适合做 | 相关性门卫：有没有任何一条够格 | 质量排序：够格的里面谁更强 |

RRF 公式的满分是 1/61+1/61≈0.033，永远到不了 0.3。用 rrfScore 做绝对地板是数学矛盾。

**做法**：取候选集中所有 `vectorScore` 的最大值（排除 undefined——纯文本检索降级场景无 vectorScore，直接跳过本步）。若最大值 < `MEMORY_SELECTION_MIN_VECTOR_SCORE`（默认 0.5），直接返回空 selected，不跑后续管道。若 ≥ 阈值，进入 A1。

**降级保护**：候选集无任何 vectorScore（纯 BM25 降级检索）→ 跳过 A0，直接进入 A1。

**BM25 独有记忆为何不需要地板**：

| 来源 | 有 vectorScore？ | 地板行为 | 原因 |
|---|---|---|---|
| 双路都命中 | ✅ | 生效 | 向量+关键词双重确认 |
| 仅向量命中 | ✅ | 生效 | 向量独有，必须经地板过滤 |
| 仅 BM25 命中 | ❌ | 跳过 | 关键词精准匹配本身就是相关性担保 |

BM25 靠分词做 exact/partial match（"小熊"→"小熊"），结果天然比向量检索更精确——BM25 的优势是**高精确**，劣势是**低召回**（同义词覆盖不到）。对 BM25 独有的记忆再加一道向量相似度地板，等于拿 BM25 的短板测 BM25 的长板，没有意义。

BM25 误召回（如"小熊饼干"匹配"小熊宠物"）会被 A1 百分位截断处理：单项 BM25 命中只有一个排名分，RRF 总分远低于双路命中项，在候选集中天然垫底，P70 截断大概率掐掉。

**即：A0 门卫拦向量均匀噪声，A1 门卫拦长尾噪声（含 BM25 误召回）。两道光栅各司其职，不重叠。**

**关键决策**：
- 0.5 为初值，需线上观察后校准（过严可降至 0.4，过松可升至 0.6）。
- 地板触发可通过 metadata 反推：`totalCandidates > 0 && selected === []` 唯一标识触发（正常管道 Top-1 兜底保证不会空输出）。

### A1 — 百分位阈值过滤（长尾噪声兜底）

**目标**：丢弃 RRF 分数显著偏低的噪声记忆，不固定 Top-K。

**做法**：
1. **百分位计算**：取所有候选的 `rrfScore`，按**线性插值法**（与 NumPy `percentile(method='linear')` 一致）计算第 N 百分位值（默认 N=70）。保留 `rrfScore >= percentileValue` 的记忆。
2. **空集兜底**：若过滤后为空，强制取 `rrfScore` 最高的一条（避免完全失忆）。

**关键决策**：
- 百分位而非绝对阈值：RRF 分数不跨查询可比，绝对值无意义。
- P70 而非 P50/P60：P70 的含义是"丢弃后 30% 低分噪声"，本身就是保守策略。P50 砍掉一半反而更激进，与噪声兜底定位矛盾。
- 百分位是兜底去噪手段，不是质量排序主裁判——RRF 粗排仍是主裁判，此管道只负责掐掉长尾。

**metadata 记录**：`totalCandidates`、`percentileThreshold`、`afterPercentile`。

> A0 地板触发可由 metadata 反推（`totalCandidates > 0 && selected === []`），无需额外字段。

## 4. Pipeline B — 贪心语义去重（多样性保障）

**目标**：去除内容高度重复的记忆，节省 Token，避免 LLM 被重复信息过度加权。

**做法**：
1. 对 A 输出的候选集，通过 `embeddingProvider.batchGet(ids)` 批量获取 embedding 向量。
   - 返回 `Map<string, number[] | null>`：`null` 表示该条记忆 embedding 缺失（历史数据迁移遗漏），直接保留不参与去重比较。
   - 若 `batchGet` 整体抛异常：降级为跳过 B 管，直接返回 A 输出，metadata 标记 `dedupSkipped: true`。**可用性 > 去重质量**。
2. 按 `rrfScore` 降序遍历候选（有 embedding 的条目）：
   - 与**已保留集**中每条计算余弦相似度。
   - 若相似度 > 阈值（默认 0.88），视为重复。**保留 content.length 更长的那条**，替换已保留集中较短者。
   - 若所有已保留项相似度均 ≤ 阈值，加入已保留集。
3. 合并 embedding 缺失项（已在第 1 步直接保留），返回最终已保留集。

**关键决策**：
- 贪心而非全量 O(n²)：候选 ≤10 条时 O(n·m) 零开销且天然保留高分项。
- **保留更长者而非先到先得**：更长的记忆通常信息量更大，简单先到先得会劣化去重质量。
- **不设短文本豁免**：短文本（"用户偏好 Python""用户喜欢 Python"）正是去重要消灭的最高频冗余。豁免会让去重白做。
- 阈值 0.88 为初值，需按嵌入模型校准：TODO 注释标注"两周后基于 `metadata.droppedByDedup` 日志反推最优阈值"。

**已知局限**：贪心算法无法处理传递相似（A-B 相似、B-C 相似、A-C 不相似，可能保留 A 和 C）。候选 ≤10 条时概率极低，当前不做代码处理。metadata 预留 `dedupClusters?: string[][]` 字段供将来切 Union-Find 聚类算法时填充。

**预留缓存入口**：
- `embeddingProvider` 通过 DI 注入，接口 `{ batchGet(ids: string[]): Promise<Map<string, number[] | null>> }`。
- 默认实现直接查 Mongo。此接口为后续接入 Redis 缓存或内存 LRU 预留，选择层代码零改动。
- 本次不实现缓存（当前调用量极低，需 `selectionLatencyMs` 埋点验证后再决策）。

**metadata 记录**：`afterDedup`、`droppedByDedup`（factId 列表）、`embeddingMissing`（数量）、`dedupSkipped`（布尔）、`selectionLatencyMs`（B 管耗时）、`dedupClusters?`（预留，当前不填充）。

## 5. 硬上限兜底

**目标**：在百分位和去重之后，对最终注入量做最后一道截断，防止 Token 爆炸。

**做法**：
- 在 B 管输出后，若 `selected.length > MEMORY_SELECTION_HARD_MAX`（默认 8），截取 RRF 分数最高的前 N 条。
- 硬上限放在 A→B 之**后**，而非 A 内部。若放在 A 内部，百分位截断后量可能还 >8，去重后降回 ≤8，硬上限就误触发了；只有对"真正要注入的记忆"做截断，hardMaxDropped 才是准确数据。

**两层防御**：选择层硬上限（第一道） + Prompt 拼装层 Token 预算截断（第二道），不单点依赖。

**metadata 记录**：`hardMaxApplied`（布尔）、`hardMaxDropped`（整型）。

## 6. Pipeline C — 时效衰减微调（推迟实现，预留接口）

**推迟原因**：A+B 已经覆盖质量和多样性，C 是锦上添花。衰减因子调参需要线上数据验证，现阶段盲目设定反而可能干扰排序。

**预留公式（已修正）**：
```
finalScore = rrfScore * (recencyFloor + (1 - recencyFloor) * 0.5^(age_days / halfLifeDays))
```

**关键决策**：
- 带地板衰减，不用无地板乘法。`recencyFloor = 0.7` 保证旧记忆不被压到 0，永久事实（用户偏好、联系方式）不被近期闲聊淹没。
- `recencyHalfLifeDays = 14`（半衰期 14 天）。
- 不纳入本次实现，只预留代码结构和配置项。

## 7. 配置项聚合

| 配置项 | 默认值 | 管道 | 说明 |
|---|---|---|---|
| `MEMORY_SELECTION_MIN_VECTOR_SCORE` | 0.5 | A0 | vectorScore 绝对地板（均匀噪声门卫） |
| `MEMORY_SELECTION_PERCENTILE` | 0.7 | A1 | RRF 百分位截断线（长尾噪声兜底，非质量选择） |
| `MEMORY_SELECTION_PERCENTILE_ALGORITHM` | `'linear'` | A1 | 百分位算法：线性插值（NumPy 兼容） |
| `MEMORY_SELECTION_HARD_MAX` | 8 | 硬上限 | 最终注入最大条数 |
| `MEMORY_SELECTION_DEDUP_THRESHOLD` | 0.88 | B | 余弦相似度去重阈值（TODO：嵌入模型校准） |
| `MEMORY_SELECTION_RECENCY_ENABLED` | false | C | 时效加权开关（推迟） |
| `MEMORY_SELECTION_RECENCY_FLOOR` | 0.7 | C | 衰减地板系数 |
| `MEMORY_SELECTION_RECENCY_HALF_LIFE` | 14 | C | 衰减半衰期（天） |

## 8. 输出类型

新增 `MemorySelectionOutput` 到 `src/types/memory.d.ts`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `selected` | `MemorySearchResult[]` | 最终选中的记忆列表 |
| `metadata.totalCandidates` | `number` | 入参条数 |
| `metadata.percentileThreshold` | `number` | 本次实际 P 值截断线 |
| `metadata.afterPercentile` | `number` | 百分位过滤后剩余 |
| `metadata.afterDedup` | `number` | 去重后剩余 |
| `metadata.hardMaxApplied` | `boolean` | 是否触发硬上限 |
| `metadata.hardMaxDropped` | `number` | 硬上限截掉条数 |
| `metadata.embeddingMissing` | `number` | embedding 缺失的记忆数 |
| `metadata.dedupSkipped` | `boolean` | B 管是否因异常降级而跳过 |
| `metadata.selectionLatencyMs` | `number` | B 管 embedding 查询耗时（验证性能假设） |
| `metadata.droppedByDedup` | `string[]` | 被去重淘汰的 factId 列表 |
| `metadata.dedupClusters?` | `string[][]` | 预留：聚类结果（候选 ≤10 时不填充；当候选 >20 或观察到传递相似 case 时启用） |

## 9. 降级策略

记忆选择层在 LLM 请求的关键路径上，**可用性优先级 > 去重质量**。

| 场景 | 行为 | metadata 标记 |
|---|---|---|
| `batchGet` 全部成功 | 正常去重 | `dedupSkipped: false` |
| `batchGet` 部分 embedding 为 null | 缺失项直接保留，其余正常去重 | `embeddingMissing: N` |
| `batchGet` 抛异常 | 跳过 B 管，返回 A 输出 | `dedupSkipped: true` |
| 候选 0 条 | 直接返回空 | `totalCandidates: 0` |

## 10. 集成点

记忆选择层是纯函数，不耦合调用方。预留两个可插拔接口：

1. **embeddingProvider**：`{ batchGet(ids: string[]): Promise<Map<string, number[] | null>> }`——默认 Mongo 实现，可替换为 Redis 缓存实现。
2. **config 参数**：`select(candidates, config?)` 的 config 参数直接解耦配置来源——调用方传入常量、Redis 热配置、配置中心均可，选择层零改动。

**注意**：不设 `onMetadata` 回调——`metadata` 已在返回值中，调用方如何消费（记日志 / 塞监控 / 忽略）是调用方的自由，选择层不耦合基础设施。

## 11. 实现步骤

| 步骤 | 内容 | 交付物 |
|---|---|---|
| S1 | 新增 `memorySelection.service.ts`：实现 A（小样本保护 + 线性插值百分位 + 空集兜底）+ B（embedding 批量查询 + 贪心去重保留更长者 + 降级保护）+ 硬上限兜底。输出类型含完整 metadata。预留 `embeddingProvider` DI 入口。 | 可单测的 class |
| S2 | 新增 `MemorySelectionOutput` 类型到 `types/memory.d.ts`；配置常量入 `src/utils/config.ts`（含 `PERCENTILE_ALGORITHM` 和 `DEDUP_THRESHOLD` TODO 注释） | 类型 + 配置 |
| S3 | 预留 C 接口（方法签名 + 配置项，公式用带地板衰减，方法体注释"待实现"） | 骨架代码 |
| S4 | 单测：A 正常过滤、A 空集兜底、A 小样本跳过（≤5）、百分位算法一致性（固定数组锁预期值）、B 去重保留更长者、B 阈值边界（0.879/0.880/0.881 三组）、B 三档阈值敏感性（0.75/0.88/0.95）、B embedding 缺失降级、B batchGet 异常降级（dedupSkipped）、硬上限在 B 后触发（B 后 ≤8 则不触发）、硬上限截断、metadata 各字段正确性、全管道端到端 | `tests/services/memory/memorySelection.service.test.ts` |
| S5 | 调用方集成：在 LLM 请求构建处插入 `select()` 调用 | 确认调用方后单开 |
