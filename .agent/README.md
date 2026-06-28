# Agent Project Context

## 目标
本目录用于给 AI Coding Agent 提供“项目级上下文”，帮助其快速理解 AIQuickNote 的架构、代码约定和实现方式。

## 一句话项目定位
AIQuickNote 是一个以 Express 为核心的个人知识管理与 AI 对话服务，支持笔记、笔记本、流式聊天与短期记忆管理。

## 请求处理流程
1. 客户端请求进入 Express 应用
2. 通过 middleware 处理认证、memoryKey、trace 信息
3. 路由分发到对应 controller
4. controller 调用 service 层完成业务逻辑
5. service 访问 MongoDB / Redis / OpenAI 等依赖
6. 统一返回 JSON 或流式 SSE 响应

## 重点模块
- app.ts：应用初始化，连接数据库，注册路由和错误处理
- routes/api.route.ts：认证保护后的业务路由入口
- controllers/*：负责请求解析和响应封装
- service/*：负责数据操作和外部服务调用
- models/*：Mongoose schema 定义
- util/shortTermMemory.ts：Redis 短期记忆管理器
- service/ai.service.ts：OpenAI-compatible AI 流式调用封装

## 业务模型
- Notebook：用户创建的笔记本，支持软删除
- Note：笔记本下的笔记内容，属于用户且可软删除
- ChatMessage：用于持久化聊天历史，支持分页查询
- User：认证与用户信息模型
- MemoryFact：长期记忆事实提取的目标模型，属于后续记忆治理方向

## 代码风格
- 使用 TypeScript，尽量保持 strict 类型约束
- 采用 `@/` 路径别名
- 统一使用 `ApiResponse` 包装响应
- 错误处理以 `try/catch` + `ApiResponse.error` 为主
- 流式响应遵循 SSE 格式，前端可持续消费

## 维护建议
- 新增接口时优先遵循 controller -> service -> model 的分层
- 不要把数据库操作直接散落到路由文件中
- 新增 AI 能力时优先复用现有的 `createStreamChat` / `STM` 逻辑
- 修改短期记忆时要考虑性能、TTL 与异常降级
