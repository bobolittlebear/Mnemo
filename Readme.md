# 🧠 AI Quick Note: 基于 LLM 的智能知识检索与问答系统

项目定位：一个极简主义效率工具，旨在解决碎片化信息记录与知识检索的痛点。本项目不仅实现了基础的流式对话，更在架构设计上对标企业级 AI Agent 应用标准，探索大模型在私有知识库场景下的工程化落地。

## ✨ 核心特性 (Core Features)

- ⚡️ 极速流式响应：基于原生 Fetch API 与 Server-Sent Events (SSE) 实现大模型流式输出，提供低延迟、打字机般的丝滑交互体验。
- 🔍 智能知识问答：支持用户基于个人笔记进行自然语言检索，精准提取关键信息并生成结构化摘要。
- ☁️ 云端数据同步：采用 MERN 架构，笔记数据持久化存储于 MongoDB，支持多端同步与结构化查询，保障数据资产安全。
- 🧱 模块化架构：前后端解耦设计，前端专注 UI/UX 交互与状态管理，后端提供标准化的 RESTful/Streaming API。

## 🛠️ 技术栈 (Tech Stack)

- 前端：React + TypeScript, Vite (极速构建), Ant Design (企业级 UI 组件库)
- 后端：Node.js + Express (轻量级 RESTful API 服务)
- 数据库：MongoDB (灵活的文档型数据库，完美适配非结构化笔记数据)
- AI 集成：OpenAI API (Chat Completions & Streaming)
- 核心亮点（混合网络请求架构）：常规 RESTful API 调用采用 Axios，利用其拦截器与异常处理机制保障基础业务稳定性；针对 AI 流式响应，摒弃 Axios 限制，采用原生 Fetch API 手动处理流式数据读取（ReadableStream），实现边接收边解析边渲染。

## 🚀 进阶演进路线 (Roadmap to AI Agent)

本项目正在按照企业级 AI Agent 的标准进行持续迭代，下一阶段的核心目标包括：

- [进行中] RAG 检索增强生成：引入 LlamaIndex 与向量数据库（Chroma/Milvus），实现基于文档分块（Chunking）与混合检索的精准问答，解决大模型幻觉问题。
- [规划中] Tool Calling (工具调用)：赋予 AI 自主规划能力，使其能够根据用户意图自动调用日历、邮件或代码执行等外部工具。
- [规划中] Multi-Agent 协作：基于 LangGraph/CrewAI 框架，拆分 Researcher（检索）、Writer（总结）、Reviewer（校验）等多智能体，协同完成复杂任务。
- [规划中] 数据闭环与评测：建立用户反馈机制（点赞/踩）与自动化评测集，持续优化检索准确率与回答质量。
