# LTM 选择层评测设计（Clean Architecture × DDD）

## 0. 读者画像与 TL;DR

**读者画像**：已熟悉 Mnemo 记忆主链路（LLM 提取 → contentHash 去重 → BM25+Vector 混合检索 RRF 融合 → 选择层 → 注入 LLM）的开发者 / 团队评审 / 面试官。读者想知道两件事：**(1)** 选择层在 Clean Architecture（下文 CA）与领域驱动设计（下文 DDD）里应如何归类；**(2)** 选择层的评测怎么从「机制回归」升级到「质量精度」。

> 重要前提：本项目的物理目录是扁平的（`src/services`、`src/types`、`src/utils`、`src/models`），**没有** `domain/` `application/` `infrastructure/` 这样的物理分层。本文的 CA/DDD 分层是**逻辑归类**，把已有文件映射到概念层，不新增目录、不新增抽象层。这是遵守「设计文档不得引入项目中不存在的东西」的硬规矩。

**TL;DR**

- 选择层在逻辑上横跨三层：纯规则（领域服务）＋ 编排（应用服务）＋ embedding 取数（基础设施适配器）。
- DDD 视角：`MemorySearchResult` 是带身份的领域实体，`MemorySelectionMetadata/SelectionConfig` 是值对象，`EmbeddingProvider` 是出站端口，`createDefaultEmbeddingProvider` 是 Mongo 适配器。
- 评测双轨：机制回归（recall-selection，测「四道防线是否按设计触发、保留/丢弃预期条数、异常时正确降级」）＋ 质量精度（selection-precision，测「选中的记忆是否语义相关」）。
- 精度评测当前只跑了 A0+A1+硬上限三道（B 去重因无 mock embedding 被跳过），数字是**保守下界**。
- 真实结果：四道防线把无关记忆注入率从 baseline_micro=55.1% 降到 after_micro=11.6%（相对降幅 78.9%），闸门有效性 ✅ PASS；剩余 ~12% 漏注是「分数阈值只过关分、看不懂语义」所致（详见 §7）。

---

## 1. Clean Architecture 分层映射

**TL;DR（说什么）**：把选择层代码按 CA 的依赖方向（外层依赖内层、内层不依赖外层）归到四层。**为何重要**：明确「什么是业务逻辑、什么是对外依赖」，让选择层可单测、可替换 embedding 后端。

| CA 概念层                         | 项目里真实落点                                                                                                              | 依赖方向                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Entities / 领域规则**（最内层，零框架依赖） | `linearPercentile`（`memorySelection.service.ts:53`）、`cosineSimilarity`（`:74`）——纯函数，只算数                               | 不依赖任何人                   |
| **Use Cases / 应用服务**           | `MemorySelectionService.select()`（`:154`）——编排 A0→A1→B→C→硬上限；`SelectionConfig`（`types/memory.d.ts:127`）作为入参解耦配置来源     | 依赖内层纯函数 + 端口接口，不依赖 Mongo |
| **Interface Adapters / 基础设施**  | `createDefaultEmbeddingProvider`（`:100`）——实现 `EmbeddingProvider` 端口、查 `MemoryFact` 集合；`config.ts` 常量（`:36-61`）作为配置来源 | 依赖 Mongoose，被应用服务通过端口调用  |
| **Frameworks / 评测适配器**         | `tests/evals/selection-precision.test.ts`、`recall-selection.test.ts`——注入 mock 端口、驱动用例                                | 依赖应用服务 + 夹具              |

**关键判断**：选择层的内层（纯函数 + `select` 编排）已经做到不依赖 Mongo——`select` 只通过 `EmbeddingProvider` 端口取 embedding，默认实现才碰数据库。这天然符合 CA 的「内层不依赖外层」。**不要**为了满足物理分层而把 `linearPercentile` 搬到新目录，那是过度工程。

---

## 2. DDD 概念映射

**TL;DR（说什么）**：把选择层的数据与行为映射到 DDD 的聚合 / 实体 / 值对象 / 端口 / 适配器。**为何重要**：统一团队语言，让「一次选择决策」「一条候选」「相关性真值」有精确术语。**需要决策**：聚合根的边界划在哪（下文给出结论）。

| DDD 概念                   | 项目落点                                                                                        | 说明                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Entity（领域实体）**         | `MemorySearchResult`（`types/memory.d.ts:101`）                                               | 带 `_id` 身份；含 `rrfScore`/`vectorScore`/`content`                    |
| **Value Object（值对象）**    | `MemorySelectionMetadata`（`:164`）、`SelectionConfig`（`:127`）、`MemorySelectionOutput`（`:156`） | 不可变快照，描述一次选择的结果与过程                                                 |
| **Domain Service（领域服务）** | `linearPercentile`、`cosineSimilarity`、`MemorySelectionService.select`                       | 无状态规则 + 有状态编排                                                      |
| **Outbound Port（出站端口）**  | `EmbeddingProvider`（`types/memory.d.ts:149`）                                                | 领域不关心 embedding 从哪来                                                |
| **Adapter（适配器）**         | `createDefaultEmbeddingProvider`（`memorySelection.service.ts:100`）                          | Mongo 实现端口；可换 Redis/内存                                             |
| **Aggregate（聚合）**        | 「一次选择决策」=`select(candidates, config) → MemorySelectionOutput`                               | 根 = `MemorySelectionOutput`，内含 `selected`（实体集合）＋ `metadata`（过程值对象） |

**关键判断**：聚合根划为「一次选择决策」而非「单条记忆」。理由：选择层的业务不变量（四道防线、硬上限、降级保护）都作用在候选集合上，而不是单条记忆上；`metadata` 的 `hardMaxDropped`/`dedupSkipped` 等字段只有在聚合视角下才有意义。单条 `MemorySearchResult` 是聚合内的实体，不单独构成聚合。

---

## 3. 四道防线的层归属

**TL;DR（说什么）**：把 A0/A1/B/C/硬上限分别归到领域规则层或基础设施层。**为何重要**：明确每道防线「改起来影响谁」——纯领域规则可无忧单测，碰 embedding 的需走端口。**需要决策**：B 去重的 embedding 缺失降级是否要纳入评测（见 §6）。

| 防线                        | 归属层                | 真实落点                                                                                               |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| **A0 vectorScore 绝对地板**   | 领域规则               | `select` 内 `:173-206`；阈值 `MEMORY_SELECTION_MIN_VECTOR_SCORE=0.5`（`config.ts:36`）                   |
| **A1 rrfScore P70 百分位截断** | 领域规则               | `applyPercentileCutoff`（`:274`）；`linearPercentile`（`:53`）；`MEMORY_SELECTION_PERCENTILE=0.7`（`:39`） |
| **B 语义去重**                | 领域规则（算法）＋ 基础设施（取数） | 算法 `applySemanticDedup`（`:321`）属领域；取数走 `EmbeddingProvider` 端口（基础设施）                                |
| **C 时效性提权**               | 骨架未实现              | `applyRecencyBoost`（`:476`）`TODO`；`RECENCY_ENABLED=false`（`:55`）                                   |
| **硬上限兜底**                 | 领域规则               | `select` 内 `:227-236`；`MEMORY_SELECTION_HARD_MAX=8`（`:45`）                                         |

**关键判断**：B 去重是「算法在领域层、数据在基础设施层」的典型。降级保护（`:346` 抛异常跳 B、`:377` 无 embedding 跳 B）也定义在领域编排里，但触发条件来自基础设施（Mongo 查不到 / 查失败）。这意味着评测若要验证 B，必须提供能返回真实向量的 `EmbeddingProvider` 实现——当前精度评测故意不提供，**故 B 被跳过**。

---

## 4. 评测架构：双轨制

**TL;DR（说什么）**：评测分两轨——机制回归集（测「四道防线是否按设计触发、保留/丢弃预期条数、异常时正确降级」）与质量精度集（测「选中的记忆是否语义相关」）。**为何重要**：旧 golden 集（recall）没有相关性真值，撑不起精度数字；两轨各管各的，互不替代。

```
tests/evals/
├── recall-selection.test.ts          ← 机制回归轨（已有）
├── selection-precision.test.ts       ← 质量精度轨（新增）
├── datasets/
│   ├── memory-recall.golden.json     ← 15 条，无 relevantIds
│   └── memory-precision.golden.json  ← 22 条，含 relevantIds 真值
└── reports/
    └── selection-precision_<date>.md ← 跑后生成
```

| 维度   | 机制回归轨（recall）                                          | 质量精度轨（precision）              |
| ---- | ------------------------------------------------------ | ----------------------------- |
| 测什么  | `selectedCount`/去重/硬上限/边界                              | 无关记忆注入率（相关性）                  |
| 真值   | 行为断言（如「去重后≤8 条」「空集兜底取 1 条」「batchGet 失败则 dedupSkipped」） | `relevantIds` 人工标注            |
| 门控覆盖 | 全闸门（含 B，因单测注入了 mock embedding）                         | 仅 A0+A1+硬上限（B 跳过，见 §3）        |
| 文件   | `recall-selection.test.ts`                             | `selection-precision.test.ts` |

**关键判断**：两轨不合并。机制回归保证「四道防线按设计触发、降级路径正确」，精度评测保证「选中的记忆确实相关」——前者防代码改坏闸门逻辑，后者防「闸门逻辑对但选出来的不相关」。把精度塞进 recall 集会污染其纯行为断言。

---

## 5. Precision 评测的 DDD 视角

**TL;DR（说什么）**：精度评测的夹具（golden entry）在 DDD 里是一个「评测场景聚合」，内含候选实体集合与相关性真值值对象。**为何重要**：把评测数据当作一等公民建模，标注、复用、复核都有清晰边界。**需要决策**：`relevantIds` 的标注口径（当前按「与 context 语义相关」人工判）。

`memory-precision.golden.json` 的单条 entry 字段构成（真实）：

```jsonc
{
  "id": "P1",
  "description": "Go CLI 容器化部署：4 条技术相关 + 3 条纯噪声",
  "context": "我那个用 Go 写的 CLI 工具怎么容器化部署？",
  "candidates": [ { "_id","content","rrfScore","vectorScore","category",... } ],
  "config": {},
  "expected": { "relevantIds": ["m1","m2","m3","m4"] }
}
```

| DDD 概念     | 映射                                                          |
| ---------- | ----------------------------------------------------------- |
| 评测场景聚合     | 单个 entry（P1…P22）                                            |
| 候选实体       | `candidates[]` 中每项（身份 = `_id`）                              |
| 相关性真值（值对象） | `expected.relevantIds`——人工标注的「应被选中」集合                       |
| 评分用例（应用服务） | `selection-precision.test.ts` 中 `select()` 调用 ＋ baseline 计算 |

**关键判断**：`relevantIds` 是「相关性真值值对象」，不是被测系统输出。它独立于 `select()`，由人工标注，作为精度计算的 Ground Truth。

---

## 6. 指标定义

**TL;DR（说什么）**：定义五个指标——无关率、micro、macro、baseline、after、降幅。**为何重要**：这些定义决定了质量评测是否真实有效。**需要决策**：主指标取 micro 还是 macro（建议 micro 为主、macro 为副）。

- **无关记忆注入率**（单 entry）：被 `select()` 选中且 `_id ∉ relevantIds` 的条数 ÷ 选中条数。
- **micro 率（主指标，池化）**：Σ所有 entry 无关注入 ÷ Σ所有 entry 选中。反映「全局总量占比」，对大 entry 加权。
- **macro 率（副指标，逐条平均）**：各 entry 无关率的算术平均。每条对话等权，防「少数大池子掩盖小池子问题」。
- **baseline 率**：同候选按 `rrfScore` 降序取 top-K（K=`MEMORY_SELECTION_HARD_MAX=8`）直接注入（`selection-precision.test.ts:96-99`），代表「四道防线全关」的对照。
- **after 率**：当前管线（`select()`）的输出。
- **降幅**：`baseline_micro − after_micro`（绝对 pp）/ 相对 %。

**关键判断**：baseline 必须是「同候选、同 K」的纯排序注入，否则对照不公平。`selection-precision.test.ts:96-99` 用 `slice(0, K)` 固定 K=8，与 after 的硬上限一致，保证可比。主指标取 micro——因为它衡量真实注入到 LLM 的 token 里有多少是噪声，与产品目标（降无关注入）直接挂钩；macro 仅作「每条对话体验」的补充视角。

---

## 7. 真实结果（2026-10-12 跑）

**TL;DR（说什么）**：真实跑出 after_micro=11.6% vs baseline_micro=55.1%，闸门有效但 <5% 目标未达。**需要决策**：是否补 B 去重进评测（预期仍≈12%，见 §8）。

来自 `tests/evals/reports/selection-precision_2026-10-12.md`：

| 指标       | baseline | after | 降幅                   |
| -------- | -------- | ----- | -------------------- |
| micro（主） | 55.1%    | 11.6% | 绝对 43.5pp / 相对 78.9% |
| macro（副） | 57.1%    | 11.4% | —                    |

判定：

- 闸门有效性：`after_micro ≤ baseline_micro` ✅ PASS（门控未使无关率恶化；四道防线把无关率从 55.1% 降到 11.6%）。

**漏注根因（4 条）**：P5/P9/P18/P20 各漏注 1–2 条 `m2` 类无关项，特征是「检索误排导致 vectorScore/rrfScore 偏高，但语义与 context 无关」（如 context 问「周末放松」却选中「养宠物小熊」）。A0 看 vectorScore 绝对分、A1 看 rrfScore 相对分，**两者都只看分数不看语义**，对「高分但无关」无能为力。这是分数阈值的固有盲区，不是 bug——B 去重（语义相似度）也拦不住（因为无关项彼此不相似，只是相对 query 高分），**故不需要补充B评测**。

---

## 8. 已知局限与诚实约束

**TL;DR（说什么）**：当前精度数字有两条诚实边界——B 去重未启用**为何重要**：避免把下界数字当「全闸门真实值」，也避免标注偏差被当成结论。**需要决策**：是否做标注复核 ＋ 补 B 进评测。

1. **B 去重未纳入评测（保守下界）**：`selection-precision.test.ts:59-64` 注入空 `EmbeddingProvider`（`batchGet` 返回空 Map），使 `applySemanticDedup` 在 `embedded.length===0`（`memorySelection.service.ts:377`）时直接返回、不剔除。故数字仅反映 A0+A1+硬上限三道。**真实管线多了 B 只会更优**，因此 11.6% 是无关率的**下界**。若想含 B，需补 2D mock embedding 再跑（预期仍≈12%，因漏注项彼此不相似）。
2. **去重 `dedupSkipped` 字段误标风险**：当 `embedded.length===0` 跳过时，代码返回 `dedupSkipped:false`（`:381`），与「未跑去重」语义略有出入。仅影响日志可读，不影响选择结果；精度评测已用 `embeddingMissing` 显式说明 B 跳过，不依赖该字段。

---

## 9. 运行方式与决策项

**TL;DR（说什么）**：给出怎么跑、产物落哪、以及待你拍板的 3 件事。**为何重要**：让评测可复现、结论可追溯。

**运行**：

```bash
pnpm vitest run tests/evals/selection-precision.test.ts --reporter=verbose
```

产物：`tests/evals/reports/selection-precision_<今天日期>.md`（含逐 entry 表 ＋ 汇总 ＋ 判定）。

**断言不变量**（`selection-precision.test.ts:242-244`）：

- `after_micro ≤ baseline_micro + 1e-9`（门控不得恶化）
- 报告文件已生成
