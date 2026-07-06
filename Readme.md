# AIQuickNote —— 带上下文记忆的个人 AI 笔记助手

> 一边记笔记，一边和你的知识库对话。

---

## 📖 项目背景

在飞书知识库写作时，飞书尚未上线「问问知识库」功能。我迫切需要一个能**基于个人知识库 / 学习笔记进行 AI 对话**的工具——例如让 AI 快速提炼我面试总结里的常考题目。

于是 AIQuickNote 诞生了：一个支持创建个人笔记本，并**基于笔记本知识库做 RAG 增强的 AI 聊天会话**的个人知识管理工具。

---

## ✨ 核心定位

AIQuickNote 不只是一个笔记应用，而是一个具备**完整上下文管理能力**的「笔记 + AI」工具：

- 📝 **记笔记时随时唤起 AI 对话窗口**，边问答边记录
- 🧠 **多层记忆治理机制**（短期记忆 STM + 长期记忆 LTM），让 AI 真正「记得你」
- 🔍 **基于个人笔记本的 RAG 检索**，回答有据可依
- 🛠️ **工具调用能力**，对 AI 说「把这段总结写入笔记」，Agent 自动执行
- 📋 **任务状态管理**，追踪待办与进度

---

## 🏗️ 技术栈

| 层级 | 技术 |
|------|------|
| 后端框架 | Express + TypeScript |
| 数据库 | MongoDB（Mongoose ODM） |
| AI 能力 | OpenAI API（兼容接口） |
| 缓存 / 短时记忆 | Redis |
| 定时任务 | node-cron |
| 向量检索 | *规划中* |

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
- `MemoryExtractionService`：大模型提取服务，从对话中提炼长期记忆

**三层触发机制**（开发中）：

| 层级 | 触发方式 | 说明 |
|------|----------|------|
| 第一层 | 显性结束触发 | 每次 SSE 流式响应结束后，**异步执行**（不阻塞 `[DONE]` 发送） |
| 第二层 | 超时静默触发 | 用户停止发消息超过 T 分钟（如 30 分钟），基于 `lastExtractedAt` 标记判断，使用 Cron 实现 |
| 第三层 | 强制兜底触发 | 每日固定时间（如凌晨 3 点），扫描所有存在未提取消息的会话 |

**规划中**：
- 长期记忆向量化 & 向量检索
- 长期记忆遗忘机制
- 版本冲突管理方案

---

### 3. RAG 知识库检索（规划中）
- 个人笔记向量化构建
- 混合检索（向量 + 关键词）
- 笔记更新时**先删除再重建**向量化

### 4. 工具调用（规划中）
- AI 生成内容并**直接写入笔记**
- 扩展更多 Tool：搜索、计算、绘图……

### 5. 任务状态管理（规划中）
- 任务创建、状态流转
- 与笔记联动，任务完成自动归档

---

## 🚦 开发进度

| 模块 | 状态 |
|------|------|
| 笔记本 / 笔记 CRUD | ✅ 已实现 |
| 用户登录鉴权 | ✅ 已实现（`/stream/chat` 暂未接入，允许临时会话） |
| 短期记忆 STM | ✅ 已实现 |
| traceId 会话溯源 | ✅ 已实现 |
| 长期记忆数据模型 & 提取服务 | ✅ 已实现 |
| 长期记忆三层触发机制 | 🔄 开发中 |
| 长期记忆向量化 & 检索 | 📋 规划中 |
| 笔记 RAG 向量化 & 混合检索 | 📋 规划中 |
| 笔记工具调用（AI 写入） | 📋 规划中 |
| 任务状态管理 | 📋 规划中 |

---

## 📐 项目结构（示意）

```
src/
├── controllers/          # 路由控制器
├── services/
│   ├── memory/          # 记忆治理
│   │   ├── shortTermMemory.ts   # STM（Redis List LRU）
│   │   └── memoryExtractionService.ts  # LTM 提取服务
│   ├── rag/             # RAG 检索服务（规划中）
│   └── note/            # 笔记服务
├── models/
│   ├── MemoryFact.ts    # 长期记忆事实模型
│   ├── ChatMessage.ts   # 历史会话记录模型
│   ├── Notebook.ts      # 笔记本模型
│   └── Note.ts          # 笔记模型
├── routes/              # Express 路由
├── middleware/          # 鉴权、日志等中间件
├── utils/
│   └── traceId.ts      # 会话溯源工具
└── index.ts             # 入口文件
```

---

## 🚀 快速开始

### 1. 启动 Redis

```bash
docker run -d \
  --name aiquicknote-redis \
  -p 6379:6379 \
  -v ~/work/aiquicknote-redis:/data \
  --restart always \
  redis:8.6-alpine \
  redis-server --requirepass aiquicknote
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

| 变量名 | 说明 |
|--------|------|
| `MONGODB_URI` | MongoDB 连接地址 |
| `REDIS_URL` | Redis 连接地址 |
| `OPENAI_API_KEY` | OpenAI API Key |
| `OPENAI_BASE_URL` | OpenAI 兼容接口地址（可选） |
| `JWT_SECRET` | JWT 签名密钥 |
| `PORT` | 服务端口（默认 3000） |

---

## 📡 主要 API 端点

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/auth/register` | 用户注册 | ❌ |
| POST | `/api/auth/login` | 用户登录 | ❌ |
| GET | `/api/notebooks` | 获取笔记本列表 | ✅ |
| POST | `/api/notebooks` | 创建笔记本 | ✅ |
| GET | `/api/notes` | 获取笔记列表 | ✅ |
| POST | `/api/notes` | 创建笔记 | ✅ |
| POST | `/stream/chat` | AI 流式对话（SSE） | ❌*（临时会话）* |
| GET | `/api/memory/facts` | 查看长期记忆 | ✅ |

> `* /stream/chat` 当前未接入鉴权，支持匿名临时会话，正式上线前需补全。

---

## 🎯 未来规划

- [ ] 长期记忆向量化存储与语义检索
- [ ] 笔记 RAG 混合检索（向量 + BM25）
- [ ] 记忆遗忘机制（Ebbinghaus 曲线 / 引用计数）
- [ ] Tool Calling：AI 直接操作笔记（写入、修改、删除）
- [ ] 任务状态管理模块
- [ ] 多人协作（可选）
- [ ] 前端配套（Web / 桌面端）

---

## 📄 License

MIT

---

*用 AI 记住你的知识，让笔记真正「活」起来。*
