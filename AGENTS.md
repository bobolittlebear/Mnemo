# AGENTS.md

## 项目概览

Mnemo 是一个基于 Node.js + Express 的轻量级知识管理与 AI 问答服务。核心目标是让用户把碎片化笔记、对话和知识片段整理成可检索、可问答的个人知识库。

## 技术栈

- Runtime: Node.js
- Web Framework: Express 4.x
- Language: TypeScript
- Database: MongoDB (Mongoose)
- Cache/Session Memory: Redis
- AI Integration: OpenAI-compatible chat API
- Template/View: Pug

## 代码组织原则

1. 约定的请求处理链路：routes -> controllers -> services -> models
2. 业务逻辑尽量不要直接写在 controller 中，优先放入 service 层
3. 认证与短期记忆相关逻辑走 middleware，不要绕过
4. 所有 HTTP 响应尽量复用现有的 ApiResponse 统一格式
5. 新增功能时优先保持现有风格：中文注释、简洁函数、显式错误处理

## 关键目录说明

- src/app.ts：应用入口，注册中间件、路由、错误处理
- src/routes：定义 API 路由
- src/controllers：接收请求并组装 JSON/流式响应
- src/service：封装业务逻辑与数据库/外部服务调用
- src/models：Mongoose 模型定义
- src/middleware：鉴权、记忆、trace 相关中间件
- src/util：通用工具、常量、JWT、短期记忆、流式清洗等
- src/lib：数据库连接、Redis、日志、AI 客户端封装

## 典型开发约束

- 使用路径别名 @/ 指向 src/
- 保持 TypeScript 的 strict 模式兼容
- 新增接口时优先复用现有命名风格和错误处理方式
- 对流式聊天接口，保持 SSE 兼容，避免破坏前端流式渲染
- Redis 短期记忆相关改动要保持幂等、异常可降级，不阻塞主请求
- 修改数据库模型时，评估兼容性并保持字段命名一致

## 业务上下文

- Notebook / Note：核心业务实体，用户可创建笔记本与笔记
- Chat：支持与 AI 的流式对话，并将上下文写入 Redis 与 MongoDB
- Memory：项目已具备短期记忆与长期记忆演进方向，当前以 Redis 短期记忆为主

## 常用命令

- pnpm install
- pnpm run dev
- pnpm run build
- pnpm run test-script

## 变更建议

当你需要新增功能时，优先按以下顺序修改：

1. 路由定义
2. Controller
3. Service
4. Model
5. 若需要，补充 util / middleware

请优先保持现有架构稳定，避免把业务逻辑散落在入口文件或路由文件中。
