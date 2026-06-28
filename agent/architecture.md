# Architecture Notes

## 1. 应用结构
项目采用轻量级分层结构：

- routes：定义 HTTP 路由
- controllers：请求适配与响应封装
- service：业务逻辑与依赖编排
- models：MongoDB 数据建模
- middleware：认证、内存键、trace 信息
- util/lib：共享工具、缓存、日志、AI 客户端

## 2. 关键依赖
- Express：主 Web 服务框架
- Mongoose：MongoDB ORM/ODM
- Redis：短期记忆存储与会话上下文缓存
- OpenAI SDK：接入兼容 OpenAI 的大模型服务
- Winston：日志系统

## 3. 典型调用链
以聊天功能为例：

- 路由接收 /stream/chat 请求
- controller 从请求体读取消息
- 中间件提供 `req.user.memoryKey`
- controller 从 Redis 读取最近对话作为短期记忆
- 调用 AI service 的流式接口
- 将结果边流式输出边拼接为完整回复
- 最后异步写入 Redis 和 MongoDB

## 4. 数据流设计
- 短期记忆：Redis List，按会话保存最近多轮消息
- 长期记忆：MongoDB 中存储对话消息与记忆事实，留给后续向量检索扩展
- 认证：JWT 令牌保存在 cookie 中，auth middleware 负责校验

## 5. 实现注意点
- 流式接口使用 SSE，响应头必须正确设置
- `StreamCleaner` 用于清洗重复内容，避免前端重复渲染
- `memoryMiddleware` 会生成或复用 `memory_key`，确保短期记忆命中
- AI 服务对外部接口失败有重试逻辑，且尽量保证业务降级
