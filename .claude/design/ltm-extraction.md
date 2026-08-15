## 记忆提取管道设计

---

### 1. 整体数据流

```
L1/L2/L3 触发
    │
    ▼
Pipeline.run(sessionId, userId)
    │
    ├─ Phase 0 游标去重
    ├─ Phase 1 DB 去重
    ├─ Phase 2 查已有记忆：limit(50) 最近更新
    ├─ Phase 3 LLM 提取 + 解析（保留 action/old_memory）
    ├─ Phase 4 版本处理：DELETE→软删除 / UPDATE→硬替换
    ├─ Phase 5 向量化
    ├─ Phase 6 入库（contentHash upsert）
    ├─ Phase 7 更新游标
    │
    └─ 结构化日志：{ sessionId, triggeredBy, actions, latencyMs }
```

### 2. Phase 2：已有记忆查询

防御性上限 `find({ userId }).sort({ updatedAt: -1 }).limit(50).select('_id content')`。当前用户量 < 100 条时等价于全量，用户量增长时自动限流。

**为何不用语义过滤**：当前不触发（<100 条全量 50 token），且语义过滤增加一次 embedding API 调用，省不下净耗时。500+ 时单独评估切换。

### 3. Phase 3 post-parse

`parseFacts` 解析 LLM JSON 后，保留的字段从 `{ content, confidence }` 扩展为：

`{ action, content, old_memory, confidence, category }`

- `action`：`'ADD' | 'UPDATE' | 'DELETE'`，缺省 `'ADD'`
- `old_memory`：UPDATE/DELETE 时指向已有记忆的 `_id`，ADD 时为 `null`

**两层 confidence 过滤（语义不同）**：
- 第一层（prompt 内）：LLM 输出范围锚点，< 0.5 不输出
- 第二层（post-parse）：工程侧安全兜底，< 0.6 丢弃

### 4. Phase 4：版本处理

| action | 操作 |
|---|---|
| ADD | 进入 Phase 5 向量化 + Phase 6 入库 |
| UPDATE | `deleteOne({ _id: old_memory })` → 新记录进入 Phase 5-6（硬替换，不留旧版本） |
| DELETE | 软删除：`updateOne({ _id: old_memory }, { $set: { deletedAt: new Date(), deletedReason: content } })`，不进入 Phase 5-6 |

**检索侧联动**：`memorySearch` 和 `MemoryFact.find` 全部加 `{ deletedAt: { $exists: false } }` 过滤。

**为何 UPDATE 是硬替换而非版本链**：当前无"用户想回滚记忆"的真实需求，版本链的复杂度（`supersededBy` + `isLatest`）大于收益。需求出现时再升级。

**为何 DELETE 用软删除而非硬删除**：LLM 可能幻觉——一次性删除永久消失，不可逆。软删除多两个字段，零成本留后悔药。定期清理 30 天前的软删除记录。

### 5. LLM 调用降级矩阵（新增）

| 失败类型 | 处理 |
|---|---|
| JSON 解析失败 | `p-queue` 重试 1 次（temperature=0），仍失败 → 跳过本批，游标不更新，打 error 日志 |
| LLM 超时 / 5xx | 同上 |
| 返回空 facts 数组 | 正常，直接跳到 Phase 7 更新游标 |
| embedding API 部分文本失败 | 成功的入库，失败的记录 warn log + 跳过 |

### 6. 新增约束

**长对话截断**：`MAX_EXTRACTION_MESSAGES = 50`，仅取最近 50 条消息传入 prompt。200 条消息的全量对话既不必要（远早于 50 条的话题已经没信息增量），也不可行（token 爆窗口）。

**category 兜底**：枚举值从 10 个扩至 11 个，加 `'other'`——LLM 无法归入已有类别时使用。

**并发保护**：不新增——`memoryTriggerCoordinator` 的 `processingGuard` 和锁已覆盖 L2/L3 互斥。管道层不重复锁。

**sourceMessageIds 粒度**：保持 batch 级粗粒度（一个提取批次的所有 msgId 注入每条 fact）。精确到单消息级别需要 LLM 额外输出映射关系，准确率不稳定。记入文档已知限制。

### 7. 可观测性日志（新增）

每次 pipeline 完成记一条结构化 info：

```
{
  sessionId, userId,
  triggeredBy: 'L1' | 'L2' | 'L3',
  inputMsgCount, outputFactCount,
  actions: { ADD, UPDATE, DELETE },
  latencyMs: { phase3_extraction, phase5_embedding, phase6_ingestion, total }
}
```

phase 级耗时从现有 `Date.now()` 差值拼装，不引入额外性能埋点。

### 8. 类型变更

| 类型 | 新增字段 |
|---|---|
| `RawFact` | `action?: 'ADD' \| 'UPDATE' \| 'DELETE'`、`old_memory?: string` |
| `MemoryFact` (schema) | `deletedAt?: Date`、`deletedReason?: string` |

### 9. 改动面

| 文件 | 改动 |
|---|---|
| `types/memory.d.ts` | RawFact + action/old_memory |
| `models/MemoryFact.ts` | schema + deletedAt/deletedReason + category enum 加 'other' + 删除过滤默认行为 |
| `memoryExtraction.service.ts` | parseFacts 保留 action+old_memory；重试逻辑；最大消息截断 |
| `memoryPipeline.service.ts` | Phase 2 改为 limit(50)；Phase 4 UPDATE 硬替换 + DELETE 软删除；结构化日志 |
| `memorySearch.service.ts` | $match 加 deletedAt 不存在过滤 |