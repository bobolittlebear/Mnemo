# Session 生命周期设计方案

## 1. 数据模型

### Mongo `sessions` 集合
| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string, unique | 业务主键，hex 随机数 |
| `userId` | string | 归属用户 |
| `title` | string | 首条用户消息截取前 30 字 |
| `status` | `'active' \| 'archived' \| 'deleted'` | 生命周期状态 |
| `lastActiveAt` | Date | 最后活跃时间，列表排序依据 |
| `createdAt` | Date | Mongoose timestamps 自动管理 |
| `updatedAt` | Date | Mongoose timestamps 自动管理 |

索引：`{ userId: 1, lastActiveAt: -1 }`，`sessionId` 唯一。

### Redis 绑定
`session:user:{sessionId}` = `userId`，TTL 30 天。供 `SessionIdentityResolver` 按 sessionId 解析 userId，用于 L2/L3 记忆提取。

---

## 2. 状态机

```
  ┌──────────┐  endSession  ┌───────────┐
  │  active  │─────────────→│ archived  │
  └────┬─────┘              └────┬──────┘
       │        续聊（重激活）     │
       │◄────────────────────────┘
       │
       │ clearAll
       ▼
  ┌─────────┐
  │ deleted │ （终态，不可恢复）
  └─────────┘
```

- `active` → `archived`：用户调 `POST /stream/session/end`，触发 L1 终态提取、清 STM，会话从列表隐去。
- `active` → `deleted`：用户调 `DELETE /stream/chat/history`，触发 L1 终态提取、软删 ChatMessage、清 STM 与 trigger key，不可恢复。
- `archived` → `active`：用户对已归档会话发消息，`chat` 控制器自动重置状态并正常续聊。
- `deleted` 为终态，任何操作 403。

---

## 3. 创建（新会话）

**触发**：`POST /stream/chat` body 不含 `sessionId`。

**流程**：
1. `memoryMiddleware` 从 body 取 `sessionId`，无则为 `undefined`，写入 `req.meta.sessionId`。
2. `chat` 控制器检测 `req.meta.sessionId` 为空，进入新会话分支。
3. 生成 `sessionId = crypto.randomBytes(16).toString('hex')`。
4. Redis 绑定：`SET session:user:{sid} userId EX 30d`。
5. Mongo 写入：`Session.create({ userId, sessionId, title, status: 'active' })`。
6. 设置 `req.meta.sessionId = sid`，标记 `isNew = true`。
7. SSE 首事件发射 `event: meta`，携带 `{ sessionId, title }`，供前端捕获并存储。
8. 正常流式对话。

---

## 4. 续聊

**触发**：`POST /stream/chat` body 含 `sessionId`。

**流程**：
1. 校验归属：`Session.findOne({ userId, sessionId })`，不存在 → 404，存在且 `status = 'deleted'` → 403。
2. `status = 'archived'` → 自动重置为 `'active'`。
3. 正常流式对话，不发射 `event: meta`。
4. 对话结束后 `chatStream.service` 更新 `lastActiveAt`（见第 7 节）。

---

## 5. 归档（endSession）

**触发**：`POST /stream/session/end`，body 含 `sessionId`。

**流程**：
1. 触发 L1 显性终态提取（`sessionEndTrigger.end`），将剩余消息提取入长期记忆，写 `extracted` 标记。
2. Session 文档 `status` 改为 `'archived'`。
3. 归档会话不出现在 `GET /api/sessions` 列表中。

---

## 6. 销毁（clearAll）

**触发**：`DELETE /stream/chat/history`，query 含 `sessionId`。

**流程**：
1. 触发 L1 显性终态提取。
2. ChatMessage 软删除（`isDeleted: true`）。
3. Session 文档 `status` 改为 `'deleted'`。
4. 销毁 trigger key（`sessionMemoryLifecycle.destroy`，清全部 5 个 Redis key）。
5. 销毁后任何操作 403。

---

## 7. L2 超时提取与 Session 的关系

L2 扫描器是**后台管道**，职责仅为：扫描不活跃会话 → 提取记忆入库 → 写终态标记 → 清 STM。

- **不碰** Session 文档的 `status`、`lastActiveAt` 或任何字段。
- 用户回来后会话仍是 `active`，可正常续聊。
- L2 提取的 MemoryFact 通过 `SessionIdentityResolver` 解析 userId 进行归属关联。

---

## 8. 列表查询

**接口**：`GET /api/sessions`，需认证。

**逻辑**：`Session.find({ userId, status: 'active' }).sort({ lastActiveAt: -1 }).lean()`，返回 `{ list }`。无分页，全量返回当前用户所有 active 会话。

---

## 9. 跨切面规则

### lastActiveAt
- **唯一更新点**：`chatStream.service.ts`，`sessionMemoryLifecycle.touch()` 之后同步写 Mongo `lastActiveAt`。
- **谁不更新**：L2 扫描器、endSession、clearAll 均不修改。
- **用途**：会话列表排序。

### 归属校验
- 续聊、归档、销毁、查历史，均以 Mongo `Session` 文档为归属真相源（`{ userId, sessionId }` 联合查询）。
- 非本人操作返回 403/404，杜绝越权。

### sessionId 传输
- 前端通过 `POST /stream/chat` 的 body 字段 `sessionId` 传递。
- 新会话不传，后端生成后通过 SSE `event: meta` 首事件返回。
- 前端缓存 `sessionId`，后续请求携带。
