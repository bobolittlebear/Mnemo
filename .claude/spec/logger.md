# Mnemo Logger 设计规范

> **用途**：AI Coding 实现参考 + 开发者查阅
> **技术栈**：Node.js + TypeScript + Express + Winston
> **最后更新**：2026-07-07

---

## 1. 模块一览

共 **10 个** logger 子模块，按层级分组：

| 层级 | 模块 tag | 职责 | 对应代码 |
|------|----------|------|----------|
| 接入 | `api` | HTTP 请求/响应、SSE 流式 | controllers, middleware |
| 接入 | `auth` | JWT 签发/校验、登录注册 | auth.service.ts, auth.middleware.ts |
| AI 核心 | `ai` | LLM 调用、Token 用量、流式输出 | ai.service.ts |
| AI 核心 | `agent` | Tool 调用执行、任务状态管理 | util/tool.ts, agent 相关 |
| AI 核心 | `stm` | 短期记忆读写、LRU 截断、会话清理 | util/shortTermMemory.ts |
| AI 核心 | `ltm` | 长期记忆提取、三层触发、Cron 调度 | memoryExtraction.service.ts |
| AI 核心 | `rag` | 笔记向量化、混合检索 | lib/embedding.ts, rag 相关 |
| 基础设施 | `redis` | 连接池、读写、超时 | lib/redis.ts |
| 基础设施 | `mongodb` | 连接、查询、写入、索引 | db/index.ts, models |
| 正交 | `code` | 未捕获异常、Promise rejection | 全局 process 事件 |

---

## 2. 日志等级定义

| 等级 | 值 | 语义 | 生产环境 |
|------|-----|------|----------|
| `error` | 0 | 功能不可用，需要立即关注 | 开启 |
| `warn` | 1 | 异常但系统能扛，需要留意 | 开启 |
| `info` | 2 | 关键业务节点，正常流量记录 | 开启 |
| `debug` | 4 | 开发调试，含敏感/详细数据 | 关闭 |
| `verbose` | 5 | 极细粒度，几乎不用 | 关闭 |

> 跳过 `3`（Winston 原生 `http` 级别），本项目不使用。

---

## 3. 各模块打点矩阵

### 3.1 API

```
error:  路由未找到、中间件抛未处理异常、SSE 流中断
warn:   请求超时、4xx 客户端错误（可选）、限流触发
info:   每个请求：方法 + 路径 + 状态码 + 耗时（access log 风格）
        示例: "GET /api/notes 200 45ms"
debug:  请求体、响应体、headers
```

### 3.2 Auth

```
error:  JWT 签发失败、密钥缺失
warn:   Token 即将过期、可疑的重复登录失败
info:   登录成功、注册成功（不记录密码/Token 原文）
        示例: "User login success {"userId":"xxx"}"
debug:  Token 校验过程、claim 内容
```

### 3.3 AI / LLM

```
error:  API 调用失败、模型返回异常、流式输出中断
warn:   Token 用量接近上限、重试/降级触发
info:   每次调用：模型名 + Token 用量 + 耗时
        示例: "Chat completion {"model":"gpt-4o","tokens_in":320,"tokens_out":180,"duration_ms":1200}"
debug:  完整 prompt、完整 response（可能很长，仅开发环境）
```

### 3.4 Agent / Tool

```
error:  Tool 执行失败、任务状态写入失败
warn:   Tool 超时后重试、任务队列积压
info:   Tool 调用 & 结果摘要、任务状态变更
        示例: "Tool executed {"tool":"write_note","duration_ms":200}"
debug:  完整 Tool args/result、状态机流转详情
```

### 3.5 STM（短期记忆）

```
error:  会话创建失败、记忆写入 Redis 失败
warn:   会话 TTL 即将过期、消息轮数接近上限
info:   会话创建/销毁、消息追加、LRU 截断
        示例: "Message appended {"sessionId":"xxx","rounds":5,"total":12}"
debug:  完整消息内容、窗口滑动算法细节
```

### 3.6 LTM（长期记忆）

```
error:  记忆提取失败（LLM 调用侧已在 ai 模块打点，此处关注提取流程失败）、MemoryFact 写入失败
warn:   提取结果为空（正常但值得留意）、去重过滤率过高、容量告警
info:   提取触发（显式/超时/兜底）、写入事实数量、Cron 调度执行
        示例: "Extraction completed {"trigger":"timeout","facts_count":3,"duration_ms":2300}"
debug:  提取的原始对话片段、提取出的完整事实 JSON
```

### 3.7 RAG（知识检索）

```
error:  向量化失败（Embedding API 异常）、索引写入/删除失败
warn:   检索召回率低（结果数低于阈值）、向量维度不匹配
info:   笔记向量化完成、检索请求 & 命中数
        示例: "Note embedded {"noteId":"xxx","chunks":5,"duration_ms":800}"
debug:  向量值、Top-K 相似度分数、分块详情
```

### 3.8 Redis

```
error:  连接失败、认证失败、集群不可用
warn:   慢查询（> 阈值）、连接池耗尽、正在重连
info:   连接建立/关闭
        示例: "Redis connected {"host":"localhost","port":6379}"
debug:  具体 key 读写、TTL 设置、pipeline 操作
```

### 3.9 MongoDB

```
error:  连接失败、写入失败、索引错误
warn:   慢查询（> 阈值）、连接池告警
info:   连接状态变化
        示例: "MongoDB connected {"host":"localhost","db":"mnemo"}"
debug:  查询语句、aggregation pipeline、写入文档内容
```

### 3.10 Code（正交）

```
error:  未捕获异常、unhandledRejection、uncaughtException
warn:   捕获后降级处理的异常
info:   一般不在此模块打 info
debug:  函数入口/出口追踪（仅开发用）
```

> **Code 模块是全局兜底**：任何模块中发生的未被业务 try-catch 覆盖的错误，最终都会被 Code 模块捕获。正常业务流程中，各模块自己打 `error`。

---

## 4. 输出格式

### 4.1 终端/文件格式

```
[时间戳] [级别] [模块] [请求ID] 消息 {JSON context}
```

**示例**：

```
2026-07-07 15:30:00.123 [ERROR] [redis] [req-abc123] Redis connection failed {"host":"localhost","port":6379,"error":"ECONNREFUSED"}
2026-07-07 15:30:01.456 [INFO]  [api]   [req-abc123] GET /api/notes 200 45ms
2026-07-07 15:30:02.789 [WARN]  [stm]   [req-def456] Session memory approaching limit {"sessionId":"xxx","currentSize":950,"maxSize":1000}
2026-07-07 15:30:03.012 [ERROR] [ltm]   [req-ghi789] Memory extraction failed {"component":"ai","error":"LLM timeout"}
```

### 4.2 字段规范

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `timestamp` | string | 是 | ISO 8601，精确到毫秒。Winston 的 `timestamp` format 自动生成 |
| `level` | string | 是 | `error` / `warn` / `info` / `debug` / `verbose` |
| `module` | string | 是 | 10 个 tag 之一：`api` `auth` `ai` `agent` `stm` `ltm` `rag` `redis` `mongodb` `code` |
| `requestId` | string | 推荐 | 请求追踪 ID，贯穿一次请求的所有日志。从 `req.id` 或 `traceId` 获取 |
| `message` | string | 是 | 人类可读摘要。一句话说清发生了什么 |
| `error` | string | error 时必填 | `err.message` |
| `stack` | string | error 时推荐 | `err.stack`，Winston 的 `errors` format 自动处理 |
| `component` | string | 可选 | 业务模块标注底层依赖。如 `ltm` 模块打日志时 `component: "redis"` 或 `component: "ai"` |
| `duration_ms` | number | 可选 | 耗时（毫秒），API/AI/DB 操作建议带上 |

### 4.3 错误对象处理

利用 Winston 的 `format.errors({ stack: true })`，传入 Error 对象作为最后一个参数即可自动展开 `message` 和 `stack`：

```ts
// 调用方
logger.error("Redis connection failed", { module: "redis", host, port, error: err });

// 期望输出（Winston 自动处理）
// [ERROR] [redis] Redis connection failed {..., "stack": "Error: connect ECONNREFUSED\n    at ..."}
```

---

## 5. API 设计

Logger 实例通过工厂函数创建，每个模块获取独立的 child logger：

```ts
// 推荐调用方式
import { createLogger } from "@/lib/logger";

const log = createLogger("stm");

log.info("Message appended", { sessionId, rounds, total: messages.length });
log.error("Session creation failed", { sessionId, error: err });  // err 是 Error 对象
log.warn("Memory approaching limit", { currentSize, maxSize });
```

### 5.1 API 概览

```ts
// 工厂函数
function createLogger(module: ModuleTag): Logger

// 类型
type ModuleTag = "api" | "auth" | "ai" | "agent" | "stm" | "ltm" | "rag" | "redis" | "mongodb" | "code";

interface Logger {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  verbose(message: string, context?: LogContext): void;
}

interface LogContext {
  requestId?: string;
  component?: string;
  duration_ms?: number;
  error?: Error;          // Error 对象，Winston 自动展开 stack
  [key: string]: unknown; // 模块特定的附加字段
}
```

### 5.2 使用原则

1. **每个文件/模块获取自己的 logger 实例**——不要在模块间传递 logger 对象
2. **`requestId` 从中间件注入**——通过 `AsyncLocalStorage` 或 `req.id` 传递，不要手动拼接
3. **Error 对象直接传入 context**——调用 `logger.error("msg", { error: err })`，Winston 自动处理
4. **debug 级别可以打敏感数据**——但确保生产环境 debug 级别关闭
5. **不要用字符串拼接构建 message**——`message` 是固定模板，动态数据放 context JSON

---

## 6. 环境控制

```bash
# 环境变量
LOG_LEVEL=info          # 全局日志级别，默认 info（生产）
LOG_LEVEL=debug         # 开发/调试时启用 debug
LOG_LEVEL=error         # 仅错误（极简模式）

# 按模块控制（可选，将来扩展）
LOG_LEVEL_AI=debug      # 只看 ai 模块的 debug
LOG_LEVEL_REDIS=error   # redis 模块只显示 error
```

- 生产环境：`LOG_LEVEL=info`
- 开发环境：`LOG_LEVEL=debug`
- 排查问题临时：调整单个模块级别（如 `LOG_LEVEL_AI=debug`）

---

## 7. 日志输出目标

| 目标 | 级别 | 用途 |
|------|------|------|
| Console（stdout） | info 及以上 | 开发时直接看，生产用 docker logs / pm2 logs 采集 |
| 文件（可选） | 全部 | 按天轮转，保留 30 天。排查历史问题用 |

生产环境建议直接用 stdout 输出，由容器/平台采集。本地开发可加文件输出方便回看。

---

## 8. Winston 配置要点（给实现者的提示）

- **架构：root logger + child logger**。root logger 全局唯一，管理所有 transports 和 format；`createLogger(module)` 返回 `rootLogger.child({ module })`，child 共享 transports 不重复打开文件
- **不要每个模块独立 `createLogger` + 独立 transports**：10 模块 × 3 transports = 30 个 transport 实例，文件被重复打开，写入竞争
- `format.combine()` 顺序：`injectRequestId` → `errors({ stack: true })` → `timestamp`。timestamp 必须在 errors 之后，否则 errors 处理 Error 对象时重建 info 会丢掉 timestamp。Console transport 的 format 链里也补一次 timestamp 做双重保险
- module 字段由 child logger 原生注入，无需自定义 format
- `requestId` 通过 `AsyncLocalStorage` 存储，root logger 的自定义 format 自动注入，业务代码无需每次都传
- 按模块单独控制级别：`createLogger("redis").level = "error"`（child logger 支持，不影响其他模块）

---

## 9. 示例代码片段

**中间件注入 requestId：**

```ts
// middleware/trace.middleware.ts
import { v4 as uuid } from "uuid";

export function traceMiddleware(req, res, next) {
  req.id = uuid();
  // 通过 AsyncLocalStorage 存储，供 Winston format 读取
  next();
}
```

**业务代码使用：**

```ts
// service/ai.service.ts
const log = createLogger("ai");

async function chatCompletion(messages: Message[]) {
  const start = Date.now();
  try {
    const response = await openai.chat.completions.create({ model, messages });
    log.info("Chat completion", {
      model,
      tokens_in: response.usage?.prompt_tokens,
      tokens_out: response.usage?.completion_tokens,
      duration_ms: Date.now() - start,
    });
    return response;
  } catch (err) {
    log.error("LLM call failed", { model, error: err });
    throw err;
  }
}
```

**STM 调用 Redis 时的双重打点：**

```ts
// util/shortTermMemory.ts
const stmLog = createLogger("stm");

async function appendMessage(sessionId: string, message: Message) {
  try {
    await redis.lpush(`stm:${sessionId}`, JSON.stringify(message));  // Redis 模块会打 redis 级别的日志
    stmLog.info("Message appended", { sessionId, rounds: getRoundCount(sessionId) });
  } catch (err) {
    // 此时 redis 模块已经打了一条 error，stm 再打一条说明业务影响
    stmLog.error("Message append failed — session memory unavailable", { sessionId, error: err });
    throw err;
  }
}
```

---

## 10. 参考检查清单

实现完成后逐项确认：

- [ ] 10 个模块 tag 全部可创建 logger 实例，TypeScript 类型检查通过
- [ ] `LOG_LEVEL` 环境变量控制全局级别生效
- [ ] Winston `errors({ stack: true })` 正确处理 Error 对象
- [ ] `timestamp` 格式精确到毫秒
- [ ] `requestId` 可通过 AsyncLocalStorage 自动注入
- [ ] 生产环境默认 `info` 级别，不会输出 debug/verbose
- [ ] 各模块在对应代码路径中正确打点（对照第 3 节矩阵）
- [ ] Code 模块通过 `process.on("uncaughtException")` 和 `process.on("unhandledRejection")` 全局注册
