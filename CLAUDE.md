# CLAUDE.md

## 项目概览

AIQuickNote 是一个基于 Node.js + Express 的轻量级知识管理与 AI 问答服务，目标是把碎片化笔记、对话与知识片段整理为可检索、可问答的个人知识库。

## 主要技术栈

- Runtime: Node.js
- Web Framework: Express 4.x
- Language: TypeScript
- Database: MongoDB (Mongoose)
- Cache / Session Memory: Redis
- AI Integration: OpenAI-compatible chat API
- View Template: Pug

## 项目结构说明

- src/app.ts: 应用入口，注册中间件、路由、错误处理
- src/routes: 定义 HTTP 路由
- src/controllers: 处理请求、组装响应
- src/service: 封装业务逻辑与外部服务调用
- src/models: Mongoose 模型定义
- src/middleware: 鉴权、记忆、trace 相关逻辑
- src/util: 通用工具、常量、JWT、短期记忆、流式清洗
- src/lib: 数据库连接、Redis、日志、AI 客户端封装

## 典型请求处理链路

1. Express 接收请求
2. 通过 auth / memory / trace middleware 处理上下文
3. 路由分发到 controller
4. controller 调用 service 完成业务逻辑
5. service 访问 MongoDB / Redis / AI 服务
6. 返回 JSON 或 SSE 流式响应

## 代码约定

- 使用 TypeScript，尽量保持 strict 模式兼容
- 路径别名为 @/，指向 src/
- 新增功能优先遵循 routes -> controllers -> services -> models
- 控制器尽量保持薄，业务逻辑不要散落在路由或入口文件中
- HTTP 响应优先使用现有 ApiResponse 统一格式
- 保持中文注释、显式错误处理和简洁函数风格

## 业务上下文

- Notebook / Note: 核心业务实体，用户可创建笔记本与笔记
- Chat: 支持与 AI 的流式对话，并将上下文写入 Redis 与 MongoDB
- Memory: 当前以 Redis 短期记忆为主，长期记忆治理为演进方向

## 关键实现细节

- 认证使用 JWT，保存在 cookie 中，auth middleware 负责校验
- memory middleware 会生成或复用 memoryKey，供短期记忆使用
- 聊天接口使用 SSE，保持流式响应兼容
- 短期记忆保存在 Redis，使用 List + TTL + 滑动窗口控制上下文长度
- AI 对话通过 OpenAI-compatible SDK 封装，支持流式输出与可选思考模式

## 开发与验证建议

- 常用命令：pnpm install、pnpm run dev、pnpm run build、pnpm run test-script
- 修改接口时优先确认是否影响：认证、记忆上下文、SSE 流式体验、MongoDB/Redis 数据结构
- 如果新增字段或接口，优先保持向后兼容
- 修改短期记忆或聊天流程时，务必考虑异常降级，不要阻塞主请求

## 对 Claude Code 的使用建议

- 在修改代码前，先查看相关 route / controller / service / model 的现有实现
- 优先做最小改动，保持现有架构稳定
- 避免把业务逻辑直接写进 controller 或 app.ts
- 如果涉及 AI 流式聊天、Redis 短期记忆或认证流程，优先保持已有行为一致
