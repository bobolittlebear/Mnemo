# Mnemo 笔记 RAG 召回量化评测方案 

## 0. 决策基线
- **真实语料**：corpus = 全量真实 NoteChunk（来自真实 Mongo，含生产已入库的真实向量）。
- **真实检索**：手动连真实 Atlas，真实执行 `$vectorSearch` + `$text` + RRF，不做离线近似。
- **Query 来源**：主集 = 你手标的真实信息需求（从千问/元宝提问提取，映射到笔记内容）；补集 = 少量合成 adversarial。
- **隐私**：只提交 ID / query / ground truth / 报告；**不提交任何 note 正文**。
- **触发方式**：单一形态 —— **手动触发真实 Atlas eval**，三路检索 + 全部断言一次跑完；项目无 CI，不引入自动门禁。
- **评审采纳**：1.3 / 2.1 / 2.2 / 2.3（仅显式声明分词，断言保留）/ 3.1 / 3.2 / 四·全部 / 首份 baseline 链 采纳；1.1 因无 CI 分层已自然消解；1.2 / 3.2(机制) 因"真实检索"决策作废。

## 1. 评测目标与定位
量化笔记 RAG 的**检索召回质量（recall）**，非功能正确性。回答："在真实分布语料上，用户真正会问的问题，系统能否把该召回的 chunk 排进前 K。" 这是 golden.json 单元测试（管正确性/边界）之外的第二层保障。

## 2. 评测对象
- 被测单元：`searchNotes` 三模式 —— **向量路 / BM25 路 / hybrid（RRF 融合）**。
- 检索单位是 `NoteChunk`（父子块），不是 Note。

## 3. 数据来源与构成
- **Corpus**：全量真实 NoteChunk（真实 Mongo 导出/直连）。零合成，分布与知识库完全一致。
- **Query**：
  - 主集：你基于千问/元宝真实提问提取、且**答案/主题确实在 Mnemo 中**的信息需求。
  - 补集：少量合成 adversarial（code-token / 多字节 / cross-notebook），占比 **≤20%**。
- **Ground truth**：你手标每个 query 的目标 chunkId 列表。

## 4. 真实检索执行（核心，替代模拟）
- **BM25 路**：真实 `$text` 聚合（text index 在 MongoDB server 层，任何实例可跑）。
- **向量路**：真实 `$vectorSearch`（**Atlas 独占**，社区版 Mongo 无此算子 → eval 必须连 Atlas）。
- **文档向量**：直接用库里生产已入库的真实向量，**不录制**。
- **Query 向量**：由 `searchNotes` 内部实时计算（Qwen 确定性 → 可复现），**不单独落盘**。
- **bm25_tokenizer：jieba-wasm** —— 写入时 `tokenize(content)` 存 `searchText`，查询时 `tokenize(query)`；text index 用 `language: none`（关闭词干分析），中文按词对齐，BM25 对中文有效（已代码验证：noteReindex:152/250 写分词，noteSearch:151 查分词，NoteChunk:59-64 索引 language:none）。
- **执行形态**：
  - A（初版）：手动直连 dev Atlas，notes+索引已就位，`searchNotes` 只读，零风险。
  - B（可选）：导出真实 notes → 灌入隔离 eval DB → 跑 #8 索引脚本建索引 → 跑 eval，保证可重建/可复现，并顺带验证 #8。
- **调用形态**：`pnpm eval` → 读 `.env.local` 的 Atlas URI → 连真实 Atlas（只读）→ 执行三路评测 → 报告输出到 `evals/reports/`。（具体脚本路径留待落地阶段确认，不在此固化）

## 5. 隐私与提交边界
- **提交仓库**：chunkId / noteId / notebookId、query 文本、ground truth、评测报告。
- **绝不提交**：任何 note 正文 / searchText。
- **本地留存（gitignore）**：含正文的完整数据，仅供你标注参考与离线调试；BM25 现已真实，本地文本验证仅作调试用，非评测必需。

## 6. Query 类型设计
| 类型 | 目的 | 来源 | 占比 |
|---|---|---|---|
| `paraphrase` | 语义泛化（同义改写） | 手标 | 主 |
| `exact` | 精确术语命中基线 | 手标 | 主 |
| `cross-notebook` | 跨笔记本关联 / filter 正确 | 手标 | 主 |
| `code-token` | 代码块 token 检索 | 合成 | ≤20% 内 |
| `synthetic-edge` | 多字节 / 父子块回填边界 | 合成 | ≤20% 内 |
| `negative` | 拒绝能力（应返回空） | 手标（语料真无答案） | **~10%** |

## 7. 相关性标注
- 每个 query 标注：`targetChunkIds[]` + `type` + 可选 `notebook` 约束。
- **强制 paraphrase** 抗作者偏差（禁止拿原文当 query）。
- **盲抽对冲**：标注完成一周后，随机抽 5 条，仅看 query 文本 + 候选 chunk 列表（不看旧标注）重判，不一致则修订。

## 8. 评测指标与断言（手动 Atlas eval 一次性执行）
- 向量路 `recall@K`（K=3,5）≥ baseline snapshot；
- **`hybrid ≥ 向量路`**：聚合粒度为全量查询 **macro-avg Recall@5**；单条查询允许 **±1 chunk 波动**（小样本噪声），仅当 macro-avg 退化或退化条数超容忍才判失败；
- **BM25 互补性**：hard 类查询中 **≥ 2 条**"向量 top-5 未命中但 BM25 top-5 命中"（中文 BM25 已 jieba 生效，断言有效）；
- **negative**：ground truth 为空 → 三路 top-5 中**无任何 chunk 属于 GT** 即判通过（空集天然不命中）；附加观察（非断言）：记录向量路 top-5 最高余弦分，若 **> 0.5** 标记"潜在误召回风险"供参考；
- **chunk_id 失效检测**：评测前校验每个 ground-truth chunkId 是否存在于当前真实 chunk 集合；**缺失率 > 20% 中止 + 告警"需重新标注"**；
- **语料一致性**：评测前后记录 `NoteChunk.countDocuments()` 与最新 `updatedAt`，不一致则报告标 **⚠️ corpus mutated**，结果仅供参考。

## 9. 基线 / 快照策略
- 初版不卡硬阈值，先建 snapshot 基线。
- **首份报告无对比对象**：`recall@K ≥ baseline snapshot` 断言天然通过（自比）。首份核心价值是"建立数字"而非"判定通过/失败"，报告中显式标注 **`baseline: establishing`**。
- **后续报告 `baseline` 字段写所对比的基线报告文件名**（如 `2026-08-27_baseline.md`），形成可追溯链：每份报告都能查到它对比的是哪一份。
- 快照**仅两种手动更新**：① 评测通过 + 人工确认采纳；② embedding 模型 / 分块策略变更致旧数据失效。
- 其余情况一律与当前 snapshot 对比，不自动刷新。

## 10. 触发方式
- **无 CI**，评测由你**手动执行**（连 dev Atlas，只读）。
- 触发时机：① 改动检索/分块模块（`noteSearch.service.ts` / `noteChunker.ts` 等）之后；② 调优迭代时。
- 不设置任何自动门禁。

## 11. 生命周期
- **语料增长**：新增 note → 新 chunk → 跑现有评测；若"标注为不相关的 chunk 排名高于标注为相关的 chunk" → 触发该 query 人工复审。
- **分块参数变更**：触发 chunk_id 失效检测（§8）+ 必要时重标 + 快照失效重建（§9）。
- **评测疲劳（软规则）**：改 `noteSearch.service.ts` / `noteChunker.ts` 后须手动跑一次，写入个人 checklist。

## 12. 报告格式
报告头固定包含，确保纵向可比：
```
embedding_model: qwen-text-embedding-v4
vector_dim: 1536
chunk_params: { size, overlap, semantic_threshold }
bm25_tokenizer: jieba-wasm
corpus_size: { notes: N, chunks: M }
query_count: { total, hand, synthetic, negative }
baseline: establishing | 2026-08-27_baseline.md   ← 首份写 establishing，后续写基线报告文件名
generated_at: ISO timestamp
```
正文：各模式 recall@K、hybrid≥vector（macro-avg）结果、BM25 互补 case 列表、negative 结果、corpus mutated 标记。
**报告命名**：`evals/reports/YYYY-MM-DD_<tag>.md`（如 `2026-08-27_baseline.md`、`2026-09-01_chunk-size-768.md`）。

## 13. 风险与局限
- **小语料天花板**：Feishu 迁移 100+ 文档后基本缓解；仍定位为"回归基线 + 真实分布验证"。
- **作者偏差**：paraphrase 强制 + 盲抽对冲，但单人闭环本质难免。
- **Atlas 依赖**：eval 手动触发，需你环境能连 Atlas 且有凭据；**Atlas URI 仅存 `.env.local`，不入仓库（已在 .gitignore）**。
- **真实 ANN 近似**：eval 测的是真实 ANN recall@K，本身可能 < 精确召回，属预期非 bug。
- **只读验证**：确认 `searchNotes` 内部无副作用（访问计数写入 / 变更日志）；若存在写入，需加 `--dry-run` 或确保评测不触发写入。

## 14. 与现有测试分工
- `golden.json` 单元测试：正确性、边界（多字节/重父/删除/非法 id/filter 回填）。
- 本评测：真实分布下的召回质量。两者不重叠。

---
v4 终稿已完整闭合：真实语料 / 真实检索 / 隐私边界 / 无 CI 单一手动形态 / 断言精确化（macro-avg+±1、negative 空集重定义、BM25 jieba 分词显式化且断言保留）/ chunk_id 失效检测 / 语料一致性 / 调用入口 / 报告命名与 baseline 链 / 凭据安全 / 评测疲劳软规则，全部并入。方案讨论到此完整收尾。