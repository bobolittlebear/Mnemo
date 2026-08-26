# 笔记 RAG 实现方案

## 1. 架构总览

```
用户保存笔记（自动保存 5s）
    ↓
updateNote → SADD note:reindex:pending noteId   ← 幂等去重，立即返回不阻塞
    ↓
后台单 worker（异步，与前台请求解耦）
    ↓
增量 reindex：重新切分 → contentHash diff → 只重建变化的 chunk
    ↓
NoteChunk 集合（父子块，独立于 MemoryFact）
    ↓
检索：query → 双路召回（vector + BM25）→ RRF → child top-K → parentId 回填 parent 全文
    ↓
注入 system prompt
```

**三条独立链路**：会话记忆（MemoryFact）与笔记 RAG（NoteChunk）数据层分开、检索独立、测试独立；底层共享 `rrfFusion`、`generateEmbeddings`、`tokenize` 三个纯函数。

## 2. 数据模型

**独立集合 `NoteChunk`（`notechunks`）**，不复用 MemoryFact（字段语义污染 + 检索互相稀释）。

```typescript
// src/models/NoteChunk.ts
interface INoteChunk {
  noteId: ObjectId;              // 源笔记 ref: 'Note'
  notebookId: ObjectId;          // 所属笔记本 ref: 'Notebook'
  userId: string;                // 归属用户（冗余，检索过滤）
  title: string;                 // 笔记标题（召回上下文）
  chunkType: 'parent' | 'child'; // 父子区分
  parentId?: ObjectId;           // child → parent 的 _id，parent 无此字段
  sectionPath: string[];         // 标题层级路径 ["安装指南","Docker部署","环境配置"]
  chunkIndex: number;            // 文档内全局顺序（0-based）
  content: string;               // 文本（parent=完整章节，child=段落）
  embedding?: number[];          // 仅 child 有，parent 不向量化
  searchText: string;            // nodejieba 分词（BM25）
  contentHash: string;           // 增量 diff 稳定标识
  createdAt: Date;
  updatedAt: Date;
}
```

**字段决策说明**：
- 无 `isDeleted`——派生数据物理删除（源 Note.content 随时可重建）；Note 本身软删除
- 无 `heading`——被 `sectionPath` 替代（最后一项即当前标题）
- 无 `totalChunks`——语义混乱且无用途，窗口扩展已由 parent 回填取代
- `chunkIndex` 0-based——工程惯例，避免数组操作反复 -1

**索引（4 个，不过度）**：

| 索引 | 用途 |
|---|---|
| `{ noteId: 1, chunkType: 1 }` | 按笔记查 chunk（增量 diff、删除） |
| `{ userId: 1, notebookId: 1, chunkType: 1 }` | BM25 检索前置过滤 |
| `{ searchText: 'text' }`（`language: none`） | BM25 中文检索 |
| Atlas 向量索引（filter: userId/notebookId/chunkType） | 向量检索，显式 filter 避免 post-filter |

## 3. Markdown 切片器（父子块）

`src/utils/noteChunker.ts` 纯函数，输入 note 内容，输出 `{ parents, children }`。

### 父块（parent）——自适应层级切分

```
解析标题树（# / ## / ### ... 识别层级）
从顶层递归：
  节点（含全部子内容）token ≤ 1500 → 整个节点为一个 parent
  节点 token > 1500 → 递归到下一级子标题继续判断
无标题文档 → 按 token 阈值直接切
```

- 解决：只有 `#`/`###` 无 `##`、`##` 章节过大、嵌套层级丢失
- `sectionPath` 存完整路径，保留嵌套关系
- 不向量化

### 子块（child）——结构单元 + token-aware

优先级递减：

1. **按 Markdown 结构单元切**：代码块 > 列表 > 表格 > 引用块 > 段落，结构单元不可从中切断
2. **超长单元 token-aware 切分**：按 token 边界（复用 `utils/tokenizer.ts` 的 `countTokens`），句子/列表项作为最小不可分割单元，不按字符数硬切
3. **过短 child 合并**：< 50 token 的段合并到相邻 chunk（不是跳过）

- **零重叠**：Parent-Child 模式下上下文完整性由 parent 保障，child 之间重叠是冗余
- 向量化

### 切分可观测性

切分函数返回统计信息：parent 数量、child 数量、平均/最大/最小 token 数、被强制切分次数——便于调参。

### 配置外置

`MAX_PARENT_TOKENS`（1500）、`MAX_CHILD_TOKENS`（300）、`MIN_CHILD_TOKENS`（50）等参数通过 config 传入，不硬编码，方便按文档类型调优。

## 4. 增量索引（contentHash diff）

解决"编辑一个字不重建全文"的根本手段。

```
增量 reindex(noteId)：
  重新切分 → newParents + newChildren（每个含 contentHash）
  查旧记录 oldChildren = NoteChunk.find({ noteId, chunkType: 'child' })
  对比 hash 分三类：
    新增 = new 有 old 无 → re-embed + insert
    删除 = old 有 new 无 → 物理 delete
    不变 = 两边都有 → 跳过（不 re-embed）
  parent 同理（不 embedding，只对比 hash 决定增/删）
```

- 用 contentHash 而非 chunkIndex 做 diff key——chunkIndex 在中间插入内容后会漂移
- parent 也存 contentHash——后续增量可判断章节是否变更，未变则跳过 child 重切

## 5. 脏标记队列（异步化，非并发）

```
用户保存 → SADD note:reindex:pending noteId → 立即返回（不阻塞）

后台单 worker（递归 setTimeout + try/catch 兜底）：
  noteIds = SMEMBERS note:reindex:pending
  for noteId of noteIds：          ← 串行，单 worker
    try 增量 reindex 成功 → SREM noteId
    catch 失败 → INCR note:reindex:fail:{noteId}
               → >3 次 SADD note:reindex:dead（死信 + 告警），不 SREM
  启动时先扫一次 pending 处理积压（进程重启恢复）
```

**设计决策**：
- 单 worker 串行——个人知识库 reindex 是低频后台任务，用户无感，无需并发 worker
- 成功才 SREM 而非一次性 DEL——避免误删处理窗口内新 SADD 的 noteId
- 失败计数上限 3 次——防止 embedding 永久失败（如触发 API 安全过滤）导致无限循环
- 瓶颈在 embedding API 限流，worker 层并发度 = 1，批内 embedding 用 p-limit(3~5)

## 6. 检索（复用 + 父子块回填）

`src/services/notebook/noteSearch.service.ts`：

```
query → generateEmbedding(query)
      → vectorSearch（child 的 embedding，Atlas）
      → textSearch（child 的 searchText，BM25）
      → rrfFusion 融合
      → top-K child
      → 收集命中 child 的 parentId 去重
      → $in 查询 parent 全文
      → parent 内容（title + sectionPath + content）注入 prompt
```

- parent 不向量化——只回填，命中后按 `_id` 一次 `$in` 取回
- 复用 `rrfFusion` / `generateEmbeddings` / `tokenize`，不动已测试的 memorySearch

## 7. 生命周期

| 操作 | 行为 |
|---|---|
| 笔记创建 | SADD 脏标记 → worker 全量 reindex（首次全部新增） |
| 笔记更新 | SADD 脏标记 → worker 增量 reindex（contentHash diff） |
| 笔记删除 | 硬删 `deleteMany({ noteId })`（Note 本身软删除） |

首次和更新统一走同一 `incrementalReindex(noteId)` 入口（首次 old 为空，全算新增）。

## 8. 评测集

`tests/evals/datasets/note-rag.golden.json` + snapshot 测试，覆盖：

| 场景 | 要点 |
|---|---|
| 父子切分 | 层级切分、sectionPath 路径、parentId 关联 |
| 结构单元 | 代码块/表格/列表不被切断 |
| 增量 diff | 改一段只 re-embed 变化 chunk |
| 章节重命名 | hash 变 → 识别为删+增 |
| notebookId 过滤 | 只搜指定笔记本 |
| 父子回填 | child 命中 → parent 全文正确返回 |

**切分器单测**至少覆盖：纯文本、含代码块、含表格、嵌套标题、超长单段、超短多段、混合中英文。

## 9. 实现步骤

| 步骤 | 内容 |
|---|---|
| S1 | `NoteChunk` model + schema + 4 个索引 |
| S2 | `noteChunker.ts` 切片器（父子块，纯函数 + 统计信息） |
| S3 | `noteChunker.test.ts` 单测（7 类边界） |
| S4 | `incrementalReindex` + 脏标记单 worker（含重试上限 + 死信） |
| S5 | `noteSearch.service.ts` 检索（双路 + RRF + 父子回填） |
| S6 | 评测集 + snapshot 测试 |
| S7 | 手动端到端验证 |
