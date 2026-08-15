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

| 层级            | 技术                                        |
| --------------- | ------------------------------------------- |
| 后端框架        | Express + TypeScript                        |
| 数据库          | MongoDB（Mongoose ODM）                     |
| AI 能力         | OpenAI API（兼容接口）                      |
| 缓存 / 短时记忆 | Redis                                       |
| 向量化          | text-embedding-v4（Qwen）                   |
| 向量检索        | MongoDB Atlas Vector Search + RRF 混合检索  |
| 周期任务        | 进程内 setInterval（L2 超时扫描）           |

---

## 🗂️ 核心功能模块

### 1. 笔记本 & 笔记管理

- 笔记本的创建、删除、修改、查询
- 笔记的创建、删除、修改、查询
- 支持多笔记本隔离

### 2. 上下文记忆治理机制

#### 2.1 短期记忆（STM — Short-Term Memory）

以 `前缀 + sessionId` 为 key 缓存在 Redis 中，实现方式：

- 基于 **Redis List** 实现 LRU 样式的消息截断（`LTRIM`）
- 实现按 User 消息为基准的 `getRecentRounds` **滑动窗口算法**
- 设计 **TTL 自动过期与会话清理机制**（Session TTL 7 天）
- 每次调用 LLM 时，从 STM 提取最近 N 轮历史对话注入 System Prompt
- `safeGetRecentRounds` 带超时保护的安全读取，防止 Redis 阻塞挂起请求

#### 2.2 会话管理（Session）✅

- 每轮会话生成 `traceId`，便于长期记忆提取时溯源追踪
- `Session` 数据模型（MongoDB）：`status` 三态生命周期——`active`（活跃）/ `archived`（归档）/ `deleted`（销毁），仅用户操作触发状态流转
- `lastActiveAt` 最后活跃时间，会话列表排序依据
- 新会话经 SSE `event: meta` 事件回传 `sessionId`，续聊前端携带 `sessionId` 于 body
- 归档会话续聊时自动重激活为 `active`，销毁会话拒绝对话（403）

#### 2.3 长期记忆（LTM — Long-Term Memory）✅ 主链路已跑通

**提取管道（已完成）**：

- `MemoryFact` 数据模型：存储从对话中提取的事实性记忆（按 **userId** 归属）
- `ChatMessage` 历史会话记录模型（按 **sessionId** 归属，软删除支持）
- `MemoryExtractionService`：大模型提取服务，清洗 / 过滤闲聊 / 提炼事实
- `ingestMemoryFacts`：contentHash 精确去重入库
- `MemoryPipelineService`：基于**增量游标（cursor）**的完整提取管道——读游标 → 取增量消息 → LLM 提取 → 向量化 → 去重入库 → 前移游标，天然幂等不重提
- **记忆版本管理**：LLM 输出 `action`（ADD/UPDATE/DELETE）+ `old_memory_id`，管道侧白名单校验 + 文本兜底；DELETE 软删（`deletedAt`）、UPDATE 原地更新旧记录

**三层触发机制（✅ 已完成并通过联调 / 压测）**：

| 层级 | 触发方式 | 行为 |
| ---- | -------- | ---- |
| **L1 显性触发** | 用户结束会话（endSession）/ 销毁会话（clearAll） | 增量收尾提取 + 写终态标记 + 清理 STM |
| **L2 超时触发** | 周期扫描（30 分钟一轮），会话静默超过 **3 天** | 同 L1，作为兜底安全网 |
| **L3 阈值兜底** | 会话内消息累计 ≥ 20 条 | 仅增量提取，不写终态，会话可继续 |

三层均调用同一 `pipeline.run`，提取范围由 cursor 决定，行为等价；区别仅在是否写终态、是否清理 STM。

**并发安全 —— 三阶段短锁模型**：

```
P1 短锁(<50ms)：获锁 → 检查终态 → 检查 processing → 设 processing → 释锁
P2 无锁(秒级)：await pipeline.run(sessionId)     ← LLM 提取，不持锁
P3 短锁(<50ms)：获锁 → 二次校验终态 → 写终态 + cleanup → 清 processing → 释锁
```

- **三道 SKIP 闸门**：SKIP_LOCK（获锁失败不空等）/ SKIP_TERMINAL（终态幂等）/ SKIP_PROCESSING（防重入），已通过真实并发日志验证无双重提取
- **崩溃自愈**：P2 期间进程崩溃 → processing 标记 300s 自动过期 → 后续触发重新提取，终态最终写入
- **计数防漂移**：L3 完成后 `decrBy(threshold)` 而非清零，保留提取期间并发新增的计数
- **配置不变式启动断言**：`processingTtl ≥ 2 × llmTimeoutMax + overhead`，启动期校验失败直接报错，防止调参失配

**架构约束（Clean Architecture）**：

- `trigger/` 为**纯模块**，零外部服务依赖
- 外部能力（pipeline、消息源、STM 清理）全部经**组合根 `createTriggerSystem` 依赖注入**
- STM 清理收敛至 coordinator 的 `cleanup` 端口，全仓仅组合根一处认识 STM

**Redis Key 设计**：

| Key | 用途 | TTL |
| --- | --- | --- |
| `memory:lock:{sid}` | 分布式锁（仅临界区存在） | 10s |
| `memory:session:{sid}:processing` | 防并发标记 | 300s |
| `memory:session:{sid}:extracted` | 终态标记（不可逆） | 7 天（随 Session） |
| `memory:session:{sid}:msg_count` | L3 消息计数 | 7 天 |
| `memory:session:{sid}:cursor` | 增量提取游标（归 STM 管理） | 随 Session |

#### 2.4 长期记忆向量化 & 检索 ✅

- MemoryFact 经 text-embedding-v4 向量化入库
- MongoDB Atlas Vector Search + RRF 混合检索
- nodejieba 中文预分词，`searchText` 字段支撑 BM25 文本检索
- 检索结果经记忆选择层注入对话上下文（见 2.5）

**规划中**：

- 长期记忆遗忘机制（时间衰减 + 频率 + 重要性评分）
- 会话终止后的写入闸门（ENDING 状态拒收新消息，产品打磨项）

#### 2.5 记忆选择层（Memory Selection）✅

对 RRF 融合后的候选记忆做后置过滤，四道防线：

| 管道 | 作用 |
| --- | --- |
| A0 vectorScore 绝对地板 | 拦均匀噪声（候选集全部语义不相关） |
| A1 百分位截断 | 拦长尾噪声（RRF 低分项） |
| B 贪心语义去重 | 去重，保留 content 更长者 |
| 硬上限 | 最终注入条数截断（默认 8 条） |

输出含 `metadata`（各管道过滤数据），支撑遗忘策略调优与评测断言。

#### 2.6 记忆评测集（Evals）✅

`tests/evals/` 快照测试，覆盖记忆选择层 A0/A1/B/硬上限/降级路径，含 golden 数据集与边界用例（百分位算法一致性、去重阈值边界、embedding 缺失降级）。

---

### 3. RAG 知识库检索（规划中）

- 个人笔记向量化构建
- 混合检索（向量 + 关键词）
- 笔记更新时**先删除再重建**向量化
- 多模态 RAG：支持图片、视频、音频等非文本内容的向量化与检索

### 4. 工具调用（规划中）

- AI 生成内容并**直接写入笔记**
- 扩展更多 Tool：搜索、计算……

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
| **长期记忆三层触发机制**         | ✅ **已实现**（L1/L2/L3 + 三阶段锁 + cleanup 收敛）|
| 检索注入对话上下文闭环           | ✅ 已实现（记忆选择层 + XML 注入）                 |
| Session 会话管理                 | ✅ 已实现（三态生命周期 + 列表/删除接口）          |
| 笔记 RAG 向量化 & 混合检索       | 📋 规划中（第 1 周）                               |
| 多模态 RAG（图片 / 视频 / 音频） | 📋 规划中                                          |
| 笔记工具调用（AI 写入）          | 📋 规划中                                          |
| 任务状态管理                     | 📋 规划中                                          |

### 近期里程碑（2026-07）

- ✅ 三层触发机制全链路落地：L1 显性（endSession/clearAll 双触发点）、L2 超时扫描（3 天阈值 / 30 分钟周期）、L3 阈值兜底（20 条）
- ✅ 三阶段短锁 + 三道 SKIP 闸门，真实并发日志验证无双重提取
- ✅ Clean Architecture 重构：trigger 纯模块 + 组合根依赖注入，STM 清理收敛至 cleanup 端口
- ✅ 标识符作用域拆分：ChatMessage → sessionId（会话态）/ MemoryFact → userId（知识归属）
- ✅ 配置不变式启动断言 + 单元测试（含边界用例）
- ✅ 崩溃恢复验证（kill -9 后 processing 过期自愈重提）
- ✅ L3 计数器 `decrBy` 防漂移修复、msg_count TTL 生效修复
- 🔄 大窗口（100 条）提取耗时压测

---

## 📐 项目结构（示意）

```
src/
├── controllers/                    # 路由控制器
├── db/                             # 数据库连接
├── lib/                            # 基础库（redis / logger / embedding）
├── middleware/                     # 鉴权 / 记忆 / traceId 中间件
├── models/                         # ChatMessage / MemoryFact / Note / Notebook / User
├── routes/                         # 路由注册
├── services/
│   ├── chat/                       # 对话服务（chatStream / chatHistory）
│   └── memory/                     # 记忆服务
│       ├── index.ts                # 组合根：createTriggerSystem 依赖注入
│       ├── chatMessageSource.ts    # MessageSource 实现（读 STM 滑动窗口）
│       ├── memorySearch.service.ts # 记忆混合检索（BM25 + Vector + RRF）
│       ├── memorySelection.service.ts # 记忆选择层（A0/A1/B/硬上限）
│       ├── memoryPipeline.service.ts  # 增量提取管道
│       ├── memoryExtraction.service.ts # LLM 事实提取
│       ├── memoryIngestion.service.ts  # contentHash 去重入库
│       └── trigger/                # 三层触发纯模块（零外部依赖）
│           ├── memoryTriggerCoordinator.ts   # 三阶段协调器
│           ├── memoryTriggerConfig.ts        # 配置 + 不变式断言
│           ├── messageCounter.ts             # L3 消息计数
│           ├── sessionTimeoutScanner.ts      # L2 超时扫描
│           └── ...
├── types/                          # 类型定义
└── utils/                          # shortTermMemory(STM) / tool / constant
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
| POST   | `/stream/chat`         | AI 流式对话（SSE） |  ✅               |
| GET    | `/stream/chat/history` | 获取会话历史消息   | ✅               |
| DELETE | `/stream/chat/history` | 重置会话历史消息   | ✅               |
| GET    | `/api/sessions`        | 获取会话列表       | ✅               |
| DELETE | `/api/sessions/:id`    | 删除会话           | ✅               |
| POST   | `/stream/session/end`  | 结束/归档会话      | ✅               |

---

## 🎯 未来规划

- [x] 长期记忆向量化存储与语义检索
- [x] 长期记忆三层触发机制（L1/L2/L3 + 并发安全）
- [x] 检索注入对话上下文完整闭环（记忆选择层 + XML 注入）
- [x] Session 会话管理（三态生命周期 + 列表/删除）
- [x] 记忆版本管理（ADD/UPDATE/DELETE + 软删除）
- [x] 记忆评测集（tests/evals 快照测试）
- [ ] 笔记 RAG 混合检索（向量 + BM25）
- [ ] 多模态 RAG：支持图片、视频、音频等非文本笔记的向量化与检索
- [ ] 记忆遗忘机制（时间衰减 + 频率 + 重要性评分）
- [ ] Tool Calling：AI 直接操作笔记（写入、修改、删除）
- [ ] Agent 任务状态管理模块（Tool Call 追踪 + 多轮上下文保持 + 后台异步任务）
- [ ] 多人协作（可选）
- [ ] 前端配套（Web / 桌面端）

---

## 📄 License

MIT

---

_Mnemo —— 让笔记住你的知识，让知识真正「活」起来。_
