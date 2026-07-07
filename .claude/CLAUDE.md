# Mnemo — Claude Code Project Rules

## 项目概要

Mnemo（`/ˈniːmoʊ/`）是一个带多层记忆治理的 AI 聊天个人知识管理工具。「笔记 + AI」双核心，支持基于个人笔记本做 RAG 增强对话。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript |
| 框架 | Express |
| 数据库 | MongoDB（Mongoose ODM） |
| 缓存/短时记忆 | Redis |
| AI 能力 | OpenAI 兼容 API（SSE 流式） |
| 定时任务 | node-cron |
| 日志 | Winston（10 模块分级，见 `specs/logger.md`） |
| 向量检索 | 规划中 |

## 项目结构

```
src/
├── bin/                # 脚本入口
├── controllers/        # 路由控制器
├── db/                 # MongoDB 连接
├── lib/                # 基础库（embedding, logger, redis）
├── middleware/          # 鉴权、记忆、traceId
├── models/             # ChatMessage, MemoryFact, Note, Notebook, User
├── routes/             # 路由注册
├── service/            # 业务逻辑（ai, auth, memoryExtraction, note, notebook）
├── types/              # 类型定义
└── util/               # 工具（shortTermMemory, streamCleaner, tool, constant, jwt）
```

## 模块设计规范

实现或修改以下模块前，先 `@` 引用对应 spec 文件：

| 模块 | Spec 文件 | 状态 |
|------|-----------|------|
| Logger | `@.claude/specs/logger.md` | 设计完成 |
| RAG | — | 规划中 |
| Agent | — | 规划中 |
| LTM | — | 规划中 |
| Embedding | — | 规划中 |

## 优先级原则

1. 先理解项目结构，再修改代码——改动前确认影响范围
2. 保持现有架构分层：`route → controller → service → model`，不把业务逻辑散落到入口文件
3. 优先复用现有 service / middleware / util，不引入低价值的新依赖
4. 聊天、记忆、认证相关逻辑必须考虑**兼容性**和**降级处理**（LLM 挂了不崩会话，Redis 挂了不丢数据）

## 代码风格

- TypeScript，类型清晰，避免 `any`
- 使用 Prettier / ESLint 现有约定，不引入格式化全局变动
- 遵循项目已有的命名和注释风格
- 避免大范围重构——改动粒度控制在单模块内

## Logger 规则

- 新建或修改文件时，必须引入对应模块的 logger 实例：`const log = createLogger("模块tag")`
- 模块 tag 共 10 个：`api` `auth` `ai` `agent` `stm` `ltm` `rag` `redis` `mongodb` `code`
- 具体打点矩阵见 `.claude/specs/logger.md`
- `error` 级别必须携带 Error 对象，`info` 级别对 AI/DB/API 操作必须携带 `duration_ms`

## 变更注意事项

- 新接口走 `route → controller → service → model`，不在 controller 里写业务逻辑
- 流式响应保持 SSE 兼容，`stream/chat` 端点的 `[DONE]` 标记不能丢
- Redis / MongoDB 改动需考虑：连接断开、超时、数据不存在时的默认行为和降级
- 保持现有 API 响应格式一致，使用 `util/apiResponse.ts` 的统一封装
- LTM 记忆提取是异步的，不能在 SSE `[DONE]` 之前阻塞
- `stream/chat` 暂未接入鉴权（允许临时会话），改动 auth 模块时注意不影响该端点
