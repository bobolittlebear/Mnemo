# Mnemo — Claude Code 实现指南

> 将此文件放在项目根目录作为 `CLAUDE.md`，Claude Code 会自动读取。

## 项目概况

Mnemo 是一个带上下文记忆的个人 AI 笔记助手。Express + TypeScript + MongoDB + Redis + OpenAI 兼容 API。

**包管理器**：pnpm
**运行时**：Node.js 22
**AI 供应商**：阿里云 DashScope（Qwen 系列，OpenAI 兼容协议）

## 架构分层（严格遵守）

```
Controller（薄，HTTP 适配）
    ↓ 调用
Service（厚，业务逻辑归属）
    ↓ 调用
Model（薄，数据访问）
```

- **Controller** 只做：参数校验 → 调 Service → 包 `ApiResponse` 返回。禁止直接操作 Model。
- **Service** 做所有业务逻辑，抛 `new Error('中文错误信息')`，由 Controller catch。
- **Model** 只定义 Schema + 索引 + 静态方法，不含业务逻辑。

## 代码规范

### 文件命名
`{功能名}.{层级}.ts` — kebab-case

```
src/controllers/note.controller.ts
src/services/note.service.ts
src/models/Note.ts
src/lib/embedding.ts
src/utils/shortTermMemory.ts
```

### Import 规则
```typescript
// 跨目录 → 用 @/ 别名
import ApiResponse from '@/utils/apiResponse';
import { createLogger } from '@/lib/logger';
import { MemoryFact } from '@/models/MemoryFact';
import type { RawFact } from '@/types/memory';

// 同目录兄弟 → 用相对路径
import { createChat } from '../ai.service';
import noteService from '../services/note.service';
```

类型导入用 `import type`（受 `isolatedModules: true` 约束）。

### Service 导出风格
```typescript
// CRUD 服务 → 默认对象导出
export default {
    async createNote(data: CreateNoteDTO) { ... },
    async getNotes(query: GetNotesQuery) { ... },
};

// 复杂有状态服务 → 单例类导出
class MemoryPipelineService { ... }
export default new MemoryPipelineService();

// 纯函数 → 具名导出
export async function ingestMemoryFacts(...) { ... }
```

### 错误处理
```typescript
// Service 层：抛中文 Error
if (!note) throw new Error('笔记不存在');

// Controller 层：统一 catch
try {
    const data = await someService.doSomething(req.body);
    res.json(ApiResponse.success(data));
} catch (error) {
    res.json(ApiResponse.error(
        error instanceof Error ? error.message : '未知错误'
    ));
}
```

### 统一响应格式
```typescript
// ApiResponse.success(data)  → { success: true, data, message: '', timestamp }
// ApiResponse.error(message) → { success: false, data: null, message, timestamp }
```

### 软删除
所有业务模型统一用 `isDeleted: Boolean`，查询时过滤 `isDeleted: false`，删除时设为 `true`。

### 模型定义规范
```typescript
const Schema = new Schema<IModel>({
    // 业务字段...
    isDeleted: { type: Boolean, default: false },
    createUser: { type: String, default: null },
    updateUser: { type: String, default: null },
}, {
    timestamps: true,  // 自动 createdAt / updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});
```

## 基础设施接入

### AI 客户端
```typescript
import { getAIApi } from '@/services/core/llm';

const ai = getAIApi();
// 流式
const stream = await ai.chat.completions.create({ model: AI_MODEL, messages, stream: true });
// 非流式
const response = await ai.chat.completions.create({ model: AI_MODEL, messages });
// Embedding
const res = await ai.embeddings.create({ model: EMBEDDING_MODEL, input, dimensions: EMBEDDING_DIMENSIONS });
```

模型常量从 `@/utils/config` 导入：`AI_MODEL`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`、`EMBEDDING_CONFIG`。

### 重试器
```typescript
import { withRetry } from '@/lib/retry';

const result = await withRetry(() => apiCall(), {
    attempts: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    logger,
});
// 429/5xx/网络错误自动重试，4xx 立即抛出
```

### 日志
```typescript
import { createLogger } from '@/lib/logger';
const logger = createLogger('ltm'); // 模块标签
logger.info('message', { key: 'value' });
```

### Redis（短期记忆）
```typescript
import redisClient from '@/lib/redis';
import STM from '@/utils/shortTermMemory';

// 直接操作
await redisClient.set(key, value);
await redisClient.get(key);

// STM API
await STM.addMessages(sessionId, messages);
const recent = await STM.getRecentRounds(sessionId, 5);
await STM.setLastExtractedMsgId(sessionId, msgId);
```

### MongoDB
```typescript
import mongoose from 'mongoose';
// Mongoose 在 src/db/index.ts 中统一连接
// Model 定义在 src/models/ 下，直接 import 使用
import Note from '@/models/Note';
import { MemoryFact } from '@/models/MemoryFact';
```

## 环境变量

```
MONGODB_URI       MongoDB 连接地址
REDIS_URL         Redis 连接地址
REDIS_PASSWORD    Redis 密码
AI_BASE_URL       AI 服务地址（OpenAI 兼容）
AI_API_KEY        AI 服务密钥
AI_MODEL          默认对话模型
AI_MODEL_2        备用模型
JWT_SECRET        JWT 签名密钥
STM_ROUNDS        短期记忆保留轮数
LOG_LEVEL         日志级别
```

## 测试规则

| # | 规则 | 说明 |
|---|------|------|
| 1 | 单元测试与集成测试严格分离 | `tests/services/`（单元，镜像 src）vs `tests/integration/`（集成） |
| 2 | AI 接口必须完整 mock + 断言请求参数 | 不仅验证"被调了"，还要验证 role/content/temperature |
| 3 | 单元测试禁止 IO | 所有外部依赖用 `vi.mock('@/...')` 拦截 |
| 4 | 每个测试独立 | `afterEach` / `beforeEach` 清理 mock 和数据 |
| 5 | 强断言，禁止 `toBeDefined` / `toBeTruthy` | 用 `toBe()` / `toMatch()` / `toBe(true)` |
| 6 | happy path + 2 edge case + 错误处理 | 每个被测函数至少覆盖这三种场景 |

### 测试目录结构（镜像 src）
```
tests/
├── helpers/                          # 共享测试工具
├── services/memory/                  # 单元测试（镜像 src/services/memory/）
├── lib/                              # 单元测试（镜像 src/lib/）
├── integration/services/memory/      # 集成测试
└── setup.ts
```

### Mock 路径
统一用 `@/` 别名，与源码 import 路径完全一致：
```typescript
vi.mock('@/services/ai.service', () => ({ createChat: vi.fn() }));
```

## 已有模块清单

| 模块 | 状态 | 关键文件 |
|------|------|----------|
| 笔记本/笔记 CRUD | ✅ | `notebook.controller` / `note.controller` / `note.service` / `notebook.service` |
| 用户鉴权 | ✅ | `auth.controller` / `auth.service` / `auth.middleware` |
| 短期记忆 STM | ✅ | `utils/shortTermMemory.ts`（Redis List + LRU + 滑动窗口） |
| 会话溯源 | ✅ | `trace.middleware.ts`（traceId） |
| AI 对话 | ✅ | `ai.service.ts`（流式 SSE + 非流式） |
| LTM 提取管线 | ✅ | `services/memory/`（Extraction → Ingestion → Pipeline 编排） |
| 向量化 | ✅ | `lib/embedding.ts`（批量 + 并发 + 重试） |
| 重试器 | ✅ | `lib/retry.ts`（指数退避 + full jitter） |

## 待开发模块

| 模块 | 优先级 | 要点 |
|------|--------|------|
| LTM 三层触发 | P0 | SSE 后 setImmediate / Cron 超时 / 每日兜底 |
| LTM 向量化检索 | P0 | MemoryFact embedding → 向量搜索 → 上下文注入 |
| 笔记 RAG | P1 | 笔记向量化 + 混合检索（向量 + BM25） |
| Tool Calling | P1 | AI 写入笔记 + Function Calling 定义 |
| Agent 任务管理 | P2 | Tool Call 追踪 + 多轮上下文 + 后台任务状态 |
| 记忆遗忘 | P2 | Ebbinghaus 曲线 / 引用计数 |

## 实现新功能时的检查清单

1. **Controller** 是否足够薄？（只做参数校验 + 调 Service + 包装响应）
2. **Service** 是否包含所有业务逻辑？（不在 Controller 里写业务代码）
3. **Import** 是否遵循规则？（跨目录 `@/`，同目录相对路径）
4. **错误信息** 是否中文？（`throw new Error('笔记不存在')`）
5. **Model** 是否有 `isDeleted` + `timestamps`？
6. **日志** 是否用 `createLogger('模块名')`？
7. **AI 调用** 是否走 `withRetry` + `getAIApi()`？
8. **测试** 是否覆盖 happy path + edge case + 错误处理？
9. **Mock** 路径是否用 `@/` 别名？
10. **断言** 是否用强断言？（禁止 `toBeTruthy`）
