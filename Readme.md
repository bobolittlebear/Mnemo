# Mnemo —— 会记忆的笔

> 你的笔，记得一切。

---

## 📖 项目背景

在飞书知识库写作时，飞书尚未上线「问问知识库」功能。我迫切需要一个能**基于个人知识库 / 学习笔记进行 AI 对话**的工具——例如让 AI 快速提炼我面试总结里的常考题目。

于是 Mnemo /ˈniːmoʊ/ 诞生了：源自记忆女神 Mnemosyne 的名字——一个支持创建个人笔记本，并**基于笔记本知识库做 RAG 增强的 AI 聊天会话**的个人知识管理工具。

---

## ✨ 核心定位

Mnemo 不只是一个笔记应用，而是一个具备**完整上下文管理能力**的「笔记 + AI」工具：

- 📝 **记笔记时随时唤起 AI 对话窗口**，边问答边记录
- 🧠 **多层记忆治理机制**（短期记忆 STM + 长期记忆 LTM），让 AI 真正「记得你」
- 🔍 **基于个人笔记本的 RAG 检索**，回答有据可依
- 🛠️ **工具调用能力**，对 AI 说「把这段总结写入笔记」，Agent 自动执行
- 🤖 **Agent 任务状态管理**，追踪 Tool Call 执行状态、保持多轮任务上下文、管理后台异步任务

---

## 🏗️ 技术栈

| 层级            | 技术                    |
| --------------- | ----------------------- |
| 后端框架        | Express + TypeScript    |
| 数据库          | MongoDB（Mongoose ODM） |
| AI 能力         | OpenAI API（兼容接口）  |
| 缓存 / 短时记忆 | Redis                   |
| 定时任务        | node-cron               |
| 向量检索        | _规划中_                |

---

## 🗂️ 核心功能模块

### 1. 笔记本 & 笔记管理

- 笔记本的创建、删除、修改、查询
- 笔记的创建、删除、修改、查询
- 支持多笔记本隔离

### 2. 上下文记忆治理机制

#### 2.1 短期记忆（STM — Short-Term Memory）

以 `前缀 + memory_key` 为 key 缓存在 Redis 中，实现方式：

- 基于 **Redis List** 实现 LRU 样式的消息截断（`LTRIM`）
- 实现按 User 消息为基准的 `getRecentRounds` **滑动窗口算法**
- 设计 **TTL 自动过期与会话清理机制**
- 每次调用 LLM 时，从 STM 提取最近 N 轮历史对话注入 System Prompt

#### 2.2 会话溯源

- 每轮会话生成 `traceId`，便于后期长期记忆提取时溯源追踪

#### 2.3 长期记忆（LTM — Long-Term Memory）

已完成的模型与基础设施：

- `MemoryFact` 数据模型：存储从对话中提取的事实性记忆
- `ChatMessage` 历史会话记录模型
- `MemoryExtractionService` 大模型提取服务，从对话中提炼长期记忆
- `ingestMemoryFacts` 会话记忆去重入库
- `MemoryPipelineService` 长期记忆提取完整管道

**三层触发机制**（开发中）：

| 层级   | 触发方式     | 说明                                                                                     |
| ------ | ------------ | ---------------------------------------------------------------------------------------- |
| 第一层 | 显性结束触发 | 每次 SSE 流式响应结束后，**异步执行**（不阻塞 `[DONE]` 发送）                            |
| 第二层 | 超时静默触发 | 用户停止发消息超过 T 分钟（如 30 分钟），基于 `lastExtractedAt` 标记判断，使用 Cron 实现 |
| 第三层 | 强制兜底触发 | 每日固定时间（如凌晨 3 点），扫描所有存在未提取消息的会话                                |

**规划中**：

- 长期记忆向量化 & 向量检索
- 长期记忆遗忘机制
- 版本冲突管理方案

---

### 3. RAG 知识库检索（规划中）

- 个人笔记向量化构建
- 混合检索（向量 + 关键词）
- 笔记更新时**先删除再重建**向量化
- 多模态 RAG：支持图片、视频、音频等非文本内容的向量化与检索

### 4. 工具调用（规划中）

- AI 生成内容并**直接写入笔记**
- 扩展更多 Tool：搜索、计算、绘图……

### 5. Agent 任务状态管理（规划中）

管理 Agent 在执行任务过程中的全生命周期状态，覆盖三个维度：

**A. Tool Call 执行状态追踪**

- 记录每次工具调用的参数、执行结果（成功 / 失败）、耗时
- 写入笔记后关联 `noteId`，方便溯源
- 支持多步骤任务的每一步状态记录（如：搜知识库 → 生成总结 → 写入笔记）

**B. 多轮对话中的任务上下文保持**

- Agent 执行复杂任务时（跨多轮对话），保持任务上下文不丢失
- 支持断点续接：用户离开后回来，Agent 知道上次做到哪一步

**C. 后台异步任务管理**

- 长期记忆提取、笔记向量化等后台任务的状态管理
- 任务排队、执行中、完成、失败等状态流转
- 用户可查询任务进度（如「我的笔记向量化进度」）

---

## 🚦 开发进度

| 模块                             | 状态                                               |
| -------------------------------- | -------------------------------------------------- |
| 笔记本 / 笔记 CRUD               | ✅ 已实现                                          |
| 用户登录鉴权                     | ✅ 已实现（`/stream/chat` 暂未接入，允许临时会话） |
| 短期记忆 STM                     | ✅ 已实现                                          |
| traceId 会话溯源                 | ✅ 已实现                                          |
| 长期记忆数据模型 & 提取服务      | ✅ 已实现                                          |
| 长期记忆向量化 & 检索            | ✅ 已实现                                          |
| 长期记忆三层触发机制             | 🔄 开发中                                          |
| 笔记 RAG 向量化 & 混合检索       | 📋 规划中                                          |
| 多模态 RAG（图片 / 视频 / 音频） | 📋 规划中                                          |
| 笔记工具调用（AI 写入）          | 📋 规划中                                          |
| 任务状态管理                     | 📋 规划中                                          |

---

## 📐 项目结构（示意）

```
src/
├── bin/                       # 脚本入口
├── controllers/               # 路由控制器
│   ├── auth.controller.ts
│   ├── chat.controller.ts
│   ├── note.controller.ts
│   └── notebook.controller.ts
├── db/                        # 数据库连接
│   └── index.ts
├── lib/                       # 基础库与客户端
│   ├── embedding.ts           # 向量化相关
│   ├── logger.ts              # 日志工具
│   └── redis.ts               # Redis 客户端
├── middleware/                # 中间件
│   ├── auth.middleware.ts     # 鉴权
│   ├── memory.middleware.ts   # 记忆相关
│   └── trace.middleware.ts    # traceId 溯源
├── models/                    # 数据模型
│   ├── ChatMessage.ts         # 历史会话记录
│   ├── MemoryFact.ts          # 长期记忆事实
│   ├── Note.ts                # 笔记
│   ├── Notebook.ts            # 笔记本
│   └── User.ts                # 用户
├── routes/                    # 路由注册
│   ├── api.route.ts
│   ├── auth.route.ts
│   ├── chat.route.ts
│   ├── index.ts
│   └── root.route.ts
├── service/                   # 业务服务
│   ├── core/                  # 核心配置
│   │   └── config.ts
│   ├── ai.service.ts
│   ├── auth.service.ts
│   ├── memoryExtraction.service.ts  # 长期记忆提取
│   ├── note.service.ts
│   └── notebook.service.ts
├── types/models/              # 类型定义
└── util/                      # 工具函数
    ├── apiResponse.ts
    ├── constant.ts
    ├── jwt.ts
    ├── shortTermMemory.ts     # 短期记忆（STM）
    ├── streamCleaner.ts
    └── tool.ts                # 工具调用
```

---

## 🚀 快速开始

### 1. 启动 Redis

```bash
docker run -d \
  --name mnemo-redis \
  -p 6379:6379 \
  -v 你的redis目录:/data \
  --restart always \
  redis:8.6-alpine \
  redis-server --requirepass mnemo
```

### 2. 启动 Node 服务

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm run dev

# 构建生产版本
pnpm run build

# 启动生产服务器
pnpm start
```

### 环境变量说明

| 变量名           | 说明                               |
| ---------------- | ---------------------------------- |
| `MONGODB_URI`    | MongoDB 连接地址                   |
| `JWT_SECRET`     | JWT 签名密钥                       |
| `AI_BASE_URL`    | AI 服务基础地址（OpenAI 兼容接口） |
| `AI_API_KEY`     | AI 服务 API Key                    |
| `AI_MODEL`       | 默认对话模型                       |
| `AI_MODEL_2`     | 备用模型（如记忆提取、RAG 等场景） |
| `REDIS_URL`      | Redis 连接地址                     |
| `REDIS_PASSWORD` | Redis 密码                         |
| `STM_ROUNDS`     | 短期记忆保留的对话轮数             |

---

## 📡 主要 API 端点

| 方法   | 路径                   | 说明               | 鉴权             |
| ------ | ---------------------- | ------------------ | ---------------- |
| POST   | `/api/auth/register`   | 用户注册           | ❌               |
| POST   | `/api/auth/login`      | 用户登录           | ❌               |
| GET    | `/api/notebooks`       | 获取笔记本列表     | ✅               |
| POST   | `/api/notebooks`       | 创建笔记本         | ✅               |
| GET    | `/api/notes`           | 获取笔记列表       | ✅               |
| POST   | `/api/notes`           | 创建笔记           | ✅               |
| POST   | `/stream/chat`         | AI 流式对话（SSE） | ❌*（临时会话）* |
| GET    | `/stream/chat/history` | 获取会话历史消息   | ❌               |
| DELETE | `/stream/chat/history` | 重置会话历史消息   | ❌               |

> `* /stream/chat` 当前未接入鉴权，支持匿名临时会话，正式上线前需补全。

---

## 🎯 未来规划

- [ ] 长期记忆向量化存储与语义检索
- [ ] 笔记 RAG 混合检索（向量 + BM25）
- [ ] 多模态 RAG：支持图片、视频、音频等非文本笔记的向量化与检索
- [ ] 记忆遗忘机制（Ebbinghaus 曲线 / 引用计数）
- [ ] Tool Calling：AI 直接操作笔记（写入、修改、删除）
- [ ] Agent 任务状态管理模块（Tool Call 追踪 + 多轮上下文保持 + 后台异步任务）
- [ ] 多人协作（可选）
- [ ] 前端配套（Web / 桌面端）

---

## 📄 License

MIT

---

_Mnemo —— 让笔记住你的知识，让知识真正「活」起来。_
