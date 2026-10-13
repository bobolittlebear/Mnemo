# 笔记 RAG 检索质量调优设计（骨架）

> 范围：仅两项低成本改进——① jieba 自定义词典；② 静态同义词表 + query-expansion。
> 明确冻结：k1/b 调参、字段加权、rerank、HyDE（理由见 §3）。
> 关联文档：note-rag.md（架构）、2026-10-12_macro-v2.md（评测基线）。

## 读者画像

预设读者已读 note-rag.md 与 macro-v2 评测报告，已知：
- 双路召回（Atlas `$vectorSearch` + MongoDB `$text` BM25）经 score-fusion 融合，已无退化；
- `tokenize()`（src/utils/tokenizer.ts）是入库与查询共用的唯一分词出口；
- reindex 是脏标记队列（`markNoteDirty` → 单 worker → `incrementalReindex`）；
- 双盲桶 = vec@5=0 且 bm25@5=0，评测报告里 5 条真实盲区（剔除 q_session_exact 标注错配）。

---

## 0. 目标与边界（TL;DR）

- **说什么**：融合层已封顶，继续提召回只能从「query↔doc 表达对齐」与「分词精度」入手；本轮只做对症且低风险的两项。
- **为何重要**：双盲桶 5 条真实盲区根因是表达空间错位 + 专有名词被切碎，不是融合算法问题，调权重无效。
- **需要决策**：是否接受本设计的边界（只做①②、冻结③④⑤），以及 §1.3 / §2.3 的待拍板项。

---

## 1. 改进①：jieba 自定义词典（TL;DR）

- **说什么**：在 `tokenize()` 加载领域词典，让 `乐观锁 / 消费者组 / 缓存穿透 / L2超时` 等专有名词不被默认切分切碎，提升 BM25 精确词匹配。
- **为何重要**：jieba 默认字典会把复合术语切散，倒排索引存碎片，query 侧也切散 → 两侧碎片对不上，BM25 漏召回。
- **需要决策**：词典来源、加载方式、reindex 触发方式（见 §1.3）。

### 1.1 为什么这样改

`jieba-wasm` 已导出 `add_word(word, freq?, tag?)` 与 `with_dict(dict)`（node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm.d.ts:7,9）。在 `tokenize()` 首次调用前加载词典即可：因为入库（noteReindex.service.ts:168/264/319 生成 `searchText`）与查询（noteSearch.service.ts:157 `tokenize(query)`）都用同一个 `tokenize()`，**一处加载、两侧自动一致**——用户担心的「入库加词典查询没加」在本仓库结构上不会发生。

### 1.2 为什么不在别处做

不做动态 NER / 运行时词库注入：引入额外依赖与不确定性，且对当前 886 块小语料收益有限。静态词典零运行时开销，是正解。

### 1.3 决策项（待拍板）

1. **词典来源**：手写静态领域词表（从 Mnemo 代码/笔记抽取模块名、字段名、内部黑话）vs 自动从 `Note`/`NoteChunk` 抽取高频复合词。建议先手写，成本低且可控。
2. **加载方式**：`add_word` 逐条（灵活、易增量）vs `with_dict` 整包加载（一次性、需维护词典文件）。建议 `add_word` 在一个模块初始化函数里集中注册。
3. **reindex 触发**：加词典后，**已落库的 `searchText` 是用旧词典切的，必须全量重切**。新增 `forceReindexAll()`：遍历 `distinct('noteId')` 全量 `markNoteDirty`（noteReindex.service.ts:392），由现有 worker（:438）异步重建。需确认 worker 容量与 embedding 配额是否撑得住全量。

### 1.4 影响面（file:line）

- `src/utils/tokenizer.ts:50` `tokenize` —— 词典注册点（模块级一次性）。
- `src/services/notebook/noteReindex.service.ts:168,264,319` —— `searchText` 生成，reindex 后自动用新词典。
- `src/services/notebook/noteSearch.service.ts:157` —— 查询侧分词，自动一致。
- 风险：词典加载早于 WASM 初始化；`with_dict` 路径需验证 jieba-wasm 是否支持字符串词典。

---

## 2. 改进②：静态同义词表 + query-expansion（TL;DR）

- **说什么**：在 `searchNotes` 入口把口语 query 映射/扩展为文档术语，再喂给向量与 BM25 两路，让 query 进入 doc 的词汇空间。
- **为何重要**：双盲桶根因是表达错位（如「很久没说话」vs「L2 空闲超时」）。只有对齐词汇空间才能同时救两路；静态表零延迟零成本。
- **需要决策**：同义词表数据结构、匹配策略、接入点（见 §2.3）。

### 2.1 为什么这样改

query-expansion（查询扩展）：用同义词/术语改写或扩充 query 以提升召回覆盖。双盲桶里 `q_l2_para`（「用户很久没说话，系统怎么存成长期记忆」→ 文档「L2 空闲超时触发」）是典型口语↔术语错位，向量与 BM25 都因词汇不匹配漏召回。在 `searchNotes` 生成 `expandedQuery` 后，两路共用同一扩展串，对称受益，不改 score-fusion。

### 2.2 为什么不上 HyDE

HyDE（假设性文档嵌入）：先让 LLM 生成一段假想答案再向量化检索，能强解 paraphrase，但每次查询多一次 LLM 调用（延迟 + 成本 + 复杂度）。当前语料仅 886 块、query 量小，且 chat 链路已有 LLM 在环，HyDE 边际收益不抵开销。留作语料增长 10x 后的复评项。

### 2.3 决策项（待拍板）

1. **数据结构**：`Map<口语词, 术语[]>`（如 `很久没说话 → [空闲超时, L2触发]`），或双向 `Map<术语, 口语别名[]>`。建议单向口语→术语，避免误扩展。
2. **匹配策略**：精确子串匹配（query 含口语词则追加术语）vs 分词对齐（先 tokenize 再逐词查表）。建议精确子串，可控、零歧义。
3. **接入点**：`noteSearch.service.ts:216` `trimmedQuery` 之后、`generateEmbedding(trimmedQuery)`（:220）与 `textSearch(trimmedQuery)`（:231）之前，改为 `expandedQuery = expandQuery(trimmedQuery)`，两处改传 `expandedQuery`。
4. **扩展强度**：默认只追加术语（AND 语义），不替换原词，保留原 query 信号。

### 2.4 预期收益边界

仅救「口语↔术语」类（如 `q_l2_para`）。`q_tree_code`（代码块嵌入弱）、`q_edge_para`/`q_chunk_para`（概念表达错位）更靠 embedding 质量与语料覆盖，不在本项范围，需在评测里如实标注残差。

---

## 3. 明确不做（冻结项）

| 项 | 原因（基于 verify 事实） |
|---|---|
| k1/b 调参 | BM25 是 MongoDB `$text`，用固定 BM25F，k1/b 不暴露，零配置入口；调参需换后端（Atlas Search / 自写 BM25），大 scope |
| 字段加权（title 0.5 等） | 仅 `searchText` 单字段被 `$text` 索引（notechunk_searchText_text_index），title 已拼入 searchText；加权需拆字段 + reindex + 可能换后端 |
| rerank（cross-encoder） | 只救 precision@5（排序）不救 recall（双盲是没召回，排不出不存在的）；且 LLM 已在 chat 链路隐式重排，小语料冗余 |
| HyDE | 每次查询多一次 LLM 调用，886 块语料不值（见 §2.2），留作语料增长后复评 |

---

## 4. 评测回归

复用 `scripts/run-note-recall-eval.ts`，加词典 + 同义词后各重跑一次，重点观测：
- 双盲桶计数：目标 5（真实）→ ≤2（仅救得 `q_l2_para` 类即达标；不承诺归零）。
- BM25 macro@5：当前 0.589，预期小幅提升（精确词匹配）。
- precision@5：当前 0.204，预期持平或微升（本项不主攻 precision）。
- 分类 macro 的 paraphrase：当前 0.66，预期 `q_l2_para` 类收复。
- 新增观测：eval 记录哪些 query 触发了 expansion / 命中了新词典词，便于归因。

---

## 5. 落地顺序（M1 / M2）

- **M1 词典**：`tokenizer.ts` 词典注册 + 新增 `forceReindexAll` 脚本（标脏全量 noteId）+ 重跑评测验证 BM25 提升。
- **M2 同义词表**：建静态表 + `expandQuery` 函数 + `searchNotes` 接入（:216 后）+ 重跑评测验证双盲桶下降。
- 两项互不耦合（M1 动 `tokenize`，M2 动 `searchNotes` 入口），可独立上线、独立回滚。

---

## 问题清单

1. 词典先手写还是自动抽取？（建议手写）
2. `add_word` 集中注册 vs `with_dict` 整包？（建议 add_word）
3. 同义词表精确子串匹配是否可接受误扩展风险？（建议单向口语→术语）
