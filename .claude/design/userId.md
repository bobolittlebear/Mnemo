# userId 改造方案（终态设计）

> 背景：长期记忆模块（LTM）的 `MemoryFact` 按 `userId` 归属，但触发链路（L1/L2/L3）天然只有 `sessionId`。本方案解决「userId 如何进入 memory 核心域」而不污染 trigger 层 / 前端 / storage key。

## 一、标识符边界（不变）

- **sessionId**：会话态（ephemeral），纯随机，作用于 STM 游标 / trigger 的 `lock`/`processing`/`extracted`/`msg_count`/`last_active_at` / `ChatMessage` / `endSession` 终态。
- **userId**：知识归属（durable），= `User._id`，作用于 `MemoryFact.userId` / 检索过滤 / 跨会话召回。
- 二者解耦：**一个用户可拥有多个 sessionId，全部映射到同一 userId → 跨会话记忆统一**（用户心智是「我的记忆」，不是「这个窗口的记忆」）。

## 二、映射表 `session:user:{sid}`

- 结构：`session:user:{sid} = userId`，Redis 字符串，TTL 跟随会话生命周期（如 7 天）。
- 方向：单向（session→user）足够；`MemoryFact` 按 userId 落库，查询直接 `find({userId})`，无需反向。
- 存储选 Redis：与 cursor/`msg_count`/`last_active_at` 同生命周期，随会话过期，零额外 DB 往返。

## 三、写入点（一次性）：前端新建会话端点 ★

- **前端职责**：
  1. 新开对话时，**前端生成 sessionId**（纯随机 / `crypto.randomUUID()`，无 userId 前缀）。
  2. 调后端**新建会话接口** `POST /api/session`，body `{ sessionId }`。
  3. 后端认证中间件已挂 `req.user.userId`，接口内 `SET session:user:{sid} userId NX EX ttl` 建立映射。
  4. 前端缓存该 sessionId（localStorage / cookie），后续消息请求复用；「再开一个对话」则重新生成 sid + 调接口。
- **为何是一次性、放这**：新建会话是会话生命周期的起点，每次只写 1 次；**绝不放在 `streamChat`/`persistConversation`**（per-message 调用，会每条消息 SET 一次——已否）。
- **多会话天然支持**：同一 userId 多次调接口生成不同 sid，全部映射同一 userId。
- **兼容兜底**：老前端若无新建会话接口，middleware 的 cookie 懒生成仍可创建 sessionId，但**不建映射**（旧路径）→ resolver 读 null → 该会话记忆跳过（安全降级，待前端升级）。

## 四、读取点：SessionIdentityResolver（Pipeline 构造依赖）

- 接口（memory 模块自有，隔离存储实现）：

  ```ts
  interface SessionIdentityResolver {
    resolve(sessionId: string): Promise<string | null>;
    resolveBatch?(sessionIds: string[]): Promise<Map<string, string>>; // L2 批量优化
  }
  ```

- Redis 实现：`RedisSessionIdentityResolver` 读 `session:user:{sid}`；`resolveBatch` 用 MGET 一次解析 N 个 session（L2 场景 O(1) IO）。
- 注入：`MemoryPipeline` **构造函数**收 `resolver`（组合根注入），**非 call-site 参数**。
- 核心零 redis：`const userId = context.userId ?? await resolver.resolve(sessionId)`；null → warn + 跳过。
- L1 终端触发（`endSession`/`clearAll`）可显式传 `context.userId = req.user.userId`（零 IO），或走 resolver（`endSession` 罕见，多 1 次 GET 可忽略）。trigger 层签名零 userId 参数。

## 五、任务清单

| 编号 | 改动点 | 状态 |
| ---- | ---- | ---- |
| M0 | 回退复合键（middleware + adapter） | 待落地 |
| M1 | 新增 `SessionIdentityResolver` 接口 + `RedisSessionIdentityResolver`（读 `session:user:{sid}`，含 `resolveBatch`） | 待落地 |
| M2 | Pipeline 构造收 resolver；`run` 内 `userId = context.userId ?? resolver.resolve(sid)` | ✅ 已完成 |
| M3 | **新建会话端点** `POST /api/session`：`SET session:user:{sid} userId NX EX ttl` | 待落地（★重点） |
| M4 | L2 scanner 用 `resolver.resolveBatch(sids)` 一次 MGET 后循环 `pipeline.run` | 待落地 |
| M5 | 幂等去重改 userId（`find({ userId })`，已用 `context.userId`） | ✅ 已完成 |
| M6 | 入库写入改 userId（`userId: context.userId`，日志残留 `context.sessionId` 顺手清） | ✅ 已完成（日志残留待清） |
| M7 | 提取器入参 `userId: context.userId` | ✅ 已完成 |
| M8 | 检索 filter/返回改名 `memoryKey` → `userId` | ✅ 已完成 |
| M9 | `MemoryFact` 字段 + 索引 `memoryKey` → `userId` | ✅ 已完成 |
| M10 | `IngestionContext.userId` 可选 | ✅ 已完成 |

## 六、边界情况

- **匿名会话**：无 `req.user`（未登录）→ 不建映射 → resolver null → 跳过记忆。正确。
- **TTL 错位**：映射 TTL ≥ session TTL；活跃会话每次新建续期；真正长期空闲会话映射过期 → 若被 L2 捕获则跳过（安全网，不丢核心数据）。
- **旧数据迁移**：Mongo `db.MemoryFact.deleteMany({})` 清空重提（旧 userId 存的是 sessionId 串 / 复合键前缀，与 `User._id` 不同源）；Redis 旧 session 无映射键，下次请求自愈，无需手动清。
- **前端格式契约**：sessionId 纯随机，前端不得自行拼接 userId；「用户身份」只在 `session:user:{sid}` 映射里表达。

## 七、前端改造待办（登记，不在后端范围）

- 生成 sessionId 工具 + 调 `POST /api/session` 建映射。
- 会话超时检查 & 「欢迎回来」提示，可结合本端点：超时/归档后引导用户「新建对话」→ 重新生成 sid + 调接口。
- 具体组件待定位（React 19 + Vite + shadcn/ui，前端项目 `/Users/user/work/frontend`）。
