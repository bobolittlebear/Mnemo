# Codex Project Context

## 适用场景

本目录是为 Codex / LLM Agent 提供的工程化上下文，适用于功能新增、Bug 修复、接口改造和架构优化。

## 代码修改优先级

1. 保持现有分层结构，不要把 service 逻辑直接塞进 controller
2. 先理解路由与数据流，再实现功能
3. 避免破坏 SSE、JWT、Redis、MongoDB 的现有流程
4. 新增字段和接口要向下兼容，优先使用可选字段和默认值

## 具体实现建议

- 如果要新增 API：补充 route -> controller -> service -> model
- 如果要修改聊天能力：优先查看 [src/controllers/chat.controller.ts](src/controllers/chat.controller.ts) 与 [src/service/ai.service.ts](src/service/ai.service.ts)
- 如果要改笔记/笔记本逻辑：优先查看 [src/service/note.service.ts](src/service/note.service.ts) 和 [src/service/notebook.service.ts](src/service/notebook.service.ts)
- 如果要改鉴权或内存逻辑：优先查看 [src/middleware/auth.middleware.ts](src/middleware/auth.middleware.ts) 与 [src/middleware/memory.middleware.ts](src/middleware/memory.middleware.ts)

## 开发规范

- 继续使用 `export default` 的模块风格
- 代码风格保持 Prettier / ESLint 约定
- 尽量使用显式类型，避免 `any` 过多
- 对外部请求或 Redis/Mongo 访问要做好兜底异常处理

## 对 AI 的提示

在进行修改时，优先确认以下问题：

- 这个改动是否影响当前用户的记忆上下文？
- 是否会影响聊天流式响应的稳定性？
- 是否需要同步更新 MongoDB schema 或 Redis key 的使用方式？
- 是否需要保持现有 API 返回格式的一致性？
