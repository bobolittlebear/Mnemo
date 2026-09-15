# Mnemo 工具调用功能设计文档（tool-calling 细节版）

> 版本：v1.1（已定稿，2026-09-07 审批通过）  
> 日期：2026-09-07  
> 范围：产品功能设计 + 技术架构定性。不含实现步骤与代码。  
> 前版：v1.0（2026-09-07，单轮前端执行版）  
> 审稿记录：R6 docHash 降机器层、R7 role 判据定稿，均已并入

---

## 0. v1.0 → v1.1 变更摘要

**核心变更：从"单轮执行"升级为「客户端工具 + 观察回传」的完整 agent loop（方案 B，Tier 2 直上）**。v1.0 的洞已被指出并确认：LLM 吐完 patch 就"闭眼"——没有工具结果回传、没有执行 loop，失败无从重试。v1.1 补全这条闭环。

| # | 变更点       | v1.0                                         | v1.1                                                                                                                    |
| - | --------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 | 架构        | 前端执行器（单轮，无 loop）                             | 前端执行器 + tool_result 观察回传 + 消息历史续轮 loop；**否决后端直写 DB**                                                                    |
| 2 | run 生命周期  | 一次指令 = 一轮 SSE                                | 一次指令 = 一个 run = 可能多 LLM 轮次（每轮一条 SSE 流），AI 气泡跨轮次持续生长                                                                     |
| 3 | 编辑区锁      | 生成期锁                                         | **整 run 锁**（到 run_finished / 用户取消），run 期间 docHash 恒定                                                                    |
| 4 | 失败处理      | 写入失败走 error 事件                               | 双层失败：参数校验失败 → 后端合成结果直接续轮；执行失败（锚点失配）→ 前端回传 failed → 修正重试                                                                 |
| 5 | 下行事件      | thinking / tool_call / tool_status / summary | thinking / tool_call + 现有 4 事件 + **run_paused / run_finished**；tool_status 降为前端本地态；summary 事件由收尾轮文本总结取代                 |
| 6 | 上行        | 无                                            | **POST /stream/chat/tool-result**（薄结果 + docHash，内联返回下一轮 SSE）                                                            |
| 7 | 消息模型      | 扁平 `{role, content}`                         | ChatMessage 单集合扩容：`role:'tool'` + `toolCalls` / `toolCallId` + `result` / `mode` / `noteId` / `runId`；**不加 display 字段** |
| 8 | 总结语义      | 执行前结构化事件（"将写入 X"预言）                          | 执行后收尾轮事实总结（"已写入 X"）；工具摘要标注由前端 join tool 消息渲染                                                                            |
| 9 | 悬挂 / 中断兜底 | 无                                            | 合成 cancelled（上下文完整性）+ 后端补可见收尾（用户可感知性），两层都要                                                                              |

**非变更（v1.0 已定稿，v1.1 沿用）**：三工具集、显式写作模式 chip、双上下文按 noteId 隔离、全文注入 + 20 万字符闸门、LTM 注入策略、per-tool step 撤销粒度、撤销信号埋点、写模式消息携带光标/选区上下文。

---

## 1. 背景与目标

为「帮我写」能力提供**带观察回传的 agent loop 底座**：写作模式下，用户一条指令 = 一个 run，LLM 在 loop 中反复调用工具修改当前笔记标题与正文（意图判断 → Function Calling → 前端编辑器执行 → 工具结果回传 → 模型观察后继续推理或收尾），AI 对话框跨轮次展示思考 / 工具调用 / 执行状态，最后输出**执行后的事实总结**。

**对标**：飞书文档「豆包帮我写」；工具编排模式对标 Claude Code / MCP client tool（客户端执行 + 结果回传续轮）。

**V1 完整闭环**：

```
用户写作指令 → [turn1: thinking → tool_call] → run_paused
    → 前端执行 patch → POST tool_result（applied/failed）
    → 后端追加历史 → [turn2: …续轮…] → … → 收尾轮（事实总结）
    → run_finished
```

### 1.1 非目标（明确不做，防止 scope creep）

| 项                     | 决策     | 理由                                                                                                                |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| 后端直写 DB 执行工具（方案 C）    | **不做** | 编辑器是 source of truth，**后端直写 = 双写者冲突 + 需把改动实时反向同步回编辑器（协同编辑深水区）+ 绕过 contentHash → dirty-tag 索引管线 + 引入版本管理**。详见 §2.2 |
| 写入前审批 + diff 展示       | 不做（V1） | <u>单 history step 可整体撤销，破坏半径小</u>；先用撤销率数据决定是否升级（HITL 影子模式思路）                                                      |
| 文档级版本 stack           | 不做     | 解的是"编辑器历史版本"问题，与工具调用正交；真实盲区由 V1.5 的 AI patch 日志覆盖                                                                 |
| 独立 Run 集合 / 内存 run 状态 | 不做     | 消息历史即 agent 状态，零新增状态存储、刷新不丢（见 §2.3）                                                                               |
| 并行工具调用（单轮多 tool_call） | V1 不做  | V1 约束单轮最多一个工具调用，多步骤由多轮串行完成；避免多 patch 并发落笔的原子性与撤销分组问题                                                              |
| 任意块修改（edit_block）     | V2     | 需块寻址方案，复杂度接近 V1 三工具之和                                                                                             |
| 全文覆盖 / delete_block   | V2+    | 破坏性操作，需确认态设计                                                                                                      |
| 长笔记分块循环编辑             | 不做     | qwen3.7-plus 输入上限约 99 万 token，该方案解不存在的问题                                                                          |
| 气泡级"撤销此修改 / 重新生成"     | V1.5   | V1 靠 Ctrl+Z / Ctrl+Shift+Z，已知盲区记录在案（见 §9）                                                                         |

---

## 2. 架构定性：客户端工具 + 观察回传 loop

### 2.1 执行位置与 loop 正交——执行器留在前端，loop 走消息历史

两个维度是**正交**的，不要绑在一起决策：

- **执行位置**（前端 vs 后端）：跟谁持有文档权威状态走。编辑器是 source of truth，所以执行器在前端。
- **loop**（有 vs 无）：loop 的载体是**消息历史**，不是执行位置。Claude Code 的大多数工具就在客户端执行，执行完把结果 POST 回去，模型继续推理——`client_tool_call` 模式。

v1.1 定稿即**前端执行 + 观察回传续轮**。LLM 每轮看到历史里的 `assistant(tool_call)` + `tool(result)` 消息（qwen3.7-plus 原生 FC 的 tool role 标准消息），据此判断继续调用工具还是收尾。

### 2.2 为什么否决"后端直写 DB"——成本远大于"加个版本管理"

| 成本项    | 说明                                                                                           |
| ------ | -------------------------------------------------------------------------------------------- |
| 双写者冲突  | 后端直写 DB 的瞬间出现两个写者：DB 已被 AI 改掉，用户屏幕上的编辑器还是旧内容                                                 |
| 反向同步   | 需把后端改动实时推回活动编辑器（SSE → tiptap 反向事务、光标保持、undo 栈一致性、与 autoSave 竞态），等于把编辑器做成协同文档的半边——OT/CRDT 深水区 |
| 索引管线绕过 | 后端直写绕过 contentHash → dirty-tag 增量索引管线，要么改造触发条件，要么索引脏掉                                        |
| 版本管理   | 后端已提交的改动要能逻辑回滚，引入笔记版本管理（文档级快照 + 列表 UI + 与手动编辑合并语义）                                           |

方案 B 下这些全不存在：写入只发生在编辑器，autoSave 管线零改动，撤销继续走单 history step。

### 2.3 消息历史即 agent 状态（零新增状态存储）

- run 的进度**活在 ChatMessage 集合里**：各轮追加的 `assistant(toolCalls)` / `tool(result)` 消息就是状态。
- 续轮请求 = 历史 + 新消息的一次全新 LLM 调用，**无内存 run 状态、无需 Redis**，刷新页面不丢（悬挂工具调用除外，见 §3.5 兜底）。
- runId 让"一次用户指令引发的多轮调用"可聚合观测（每 run 轮次数 / 成本 / 成功率 / 失败重试路径），与请求级 traceId 互补。

### 2.4 已核实的代码基线（2026-09-07 grep / 读文件验证）

| 事实                                                                                                     | 位置                                                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| SSE 事件现有 `meta` / `delta` / `done` / `error`，controller 已留 `// event: tool_call` 占位注释                  | `express-service/src/controllers/chat.controller.ts` |
| 前端走 `@microsoft/fetch-event-source`，`ev.event` switch 分发 + `SSEEventMap` 类型化，未知事件安全降级                  | `frontend/src/utils/chatStream.ts`                   |
| `DEFAULT_MODEL: 'qwen3.7-plus'`，官方确认支持 Function Calling / tool role 消息 / 结构化输出 / 上下文缓存 / thinking 分离输出 | `express-service/src/utils/config.ts` + 阿里云模型文档      |
| AiChatWindow 消息模型为扁平 `{role, content}`，会话列表/历史拉取/归档已就绪                                                 | `frontend/src/pages/NoteEditor/AiChatWindow.tsx`     |
| ChatMessage 已预留 `role: 'tool'` 与 `msgId` 引用链（sourceMessageIds 引用 msgId），本次扩展在其上增量                      | 用户提供的 ChatMessage 接口定义（2026-09-07）                   |

---

## 3. Run 生命周期

### 3.1 定义与整体时序

**一次用户指令 = 一个 run = 可能多个 LLM 轮次；每轮一条 SSE 流。**

```
用户发写作指令（含 noteId + 光标/选区快照）
  │
  ▼ turn 1
  [SSE] meta → thinking* → tool_call {runId, toolCallId, tool, args} → run_paused（本轮流终态）
  │                                              │
  │                                ┌─────────────┘
  ▼ 前端执行                          （整 run 锁期间，文档不可被用户改动）
  tiptap 单事务写 patch（高亮 + 单 history step）
  │
  ▼ 回传
  POST /stream/chat/tool-result {toolCallId, status: applied|failed, docHash, …}
    → 后端校验并追加 tool 消息 → 内联返回下一轮 SSE
  │
  ▼ turn 2（模型看到 tool 结果后：修正重试 / 下一个工具 / 收尾）
  [SSE] meta → delta（事实总结，收尾轮）→ run_finished → done
```

- 非写作 run（纯对话、无工具轮）：走的仍是现有单条 SSE 流（meta/delta/done），零变化。
- 总结**从"预言"变"事实"**：收尾轮在工具全部执行后生成，"已写入 X"而非"将写入 X"。

### 3.2 传输：专用续轮端点

- **`POST /stream/chat/tool-result`**：请求内联续轮，响应即下一轮 SSE。前端收到 run_paused → 本地执行 → POST → 复用现有 SSE 解析器接下一轮。
- 不复用 chat 端点 + continue 标志：一条链路一个职责，贴合现有路由风格。
- 请求体（上行，非 SSE 事件）：`{ sessionId, toolCallId, status: 'applied' | 'failed', docHash, titleAfter?, error? }`。docHash 为**机器层字段**：不进入模型上下文（组装 messages 时剥离），用于锁失效守卫与观测对账（见 §6.2）。

### 3.3 锁策略：整 run 锁

- **锁的跨度从"单次生成"拉长到"整个 run"**：turn 1 生成 → patch 应用 → turn 2 生成……期间编辑器只读（顶部状态条"AI 正在写作…"），直到 `run_finished` 或用户取消。
- **为什么不做逐轮锁**：单轮解锁窗口里用户一打字 docHash 就变，turn 2 锚点全废，"文档已变更"的失败重试会从例外变常态；整 run 锁下 docHash 恒定，失败重试只剩一种确定性场景——LLM 生成了坏锚点（锚文本在文档中不存在），且模型上下文里的全文没过期，修正参数后重试必能成功。
- 体验对照：飞书"帮我写"生成长文时同样是连续书写 + 锁定感，可辩护。
- **前端解锁兜底**：网络闪断导致 SSE 中断时，前端需在断流检测后释放锁并提示重连（避免锁卡死）。run 未正常收尾的上下文完整性由 §3.5 兜底。

### 3.4 插话规则与取消出口

- **run 进行中（未 run_finished）发送框禁用**，只保留一个"取消本次"操作——防止用户插话写进历史、打断 loop 上下文。
- **取消 = 前端 abort 当前流（AbortController）+ 释放锁**，不需要后端端点。若末位 assistant 带悬挂 toolCalls，由 §3.5 合成 cancelled 收尾；若只是生成轮被中断，走既有故障呈现路径。

### 3.5 悬挂与中断兜底（两层，都要）

| 层      | 问题                                                                             | 规则                                                                                                                        |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 上下文完整性 | 前端关页/断网，`assistant(tool_call)` 已入库但 `tool(result)` 永不到达，下次组装上下文时挂着孤儿 tool_call | 组装时检测"末位 assistant 带 toolCalls 且无后继 tool 结果"→ 后端合成 `{status: 'cancelled', reason: 'client disconnected'}` 追加。模型优雅处理，历史不畸形 |
| 用户可感知性 | run 首轮即中断：只有内部轮、没有收尾轮，前端按渲染规则过滤后用户看到"发指令后无反应"                                  | run 结束时后端校验该 runId 下是否存在"可见 assistant 消息"（role=assistant 且无 toolCalls，含 content 为空的故障消息），不存在则补一条可见失败说明（"本次写作中断，请重试"）      |

---

## 4. 模式系统：写作模式与双上下文

### 4.1 显式入口

AI 对话框顶部"写作"模式 chip（正向操作常驻可见）。开启后：注入当前笔记上下文（标题 + 全文）；后端为本轮挂载工具集（LLM 此时才"看得见"工具）；每条消息携带 `noteId` + 光标/选区上下文。

**为什么显式**：纯隐式判断下"死信队列是什么"是二义请求（纯回答 vs 写入文档），误判成本高。

### 4.2 双上下文：一个消息流，两个上下文域

- 消息落同一条历史，新增 `mode` 字段（`chat` | `write`）。
- 组装 messages 时按 mode 过滤取域；另一域不进入上下文。
- 写模式上下文**按 noteId 隔离**，切换笔记弹 banner（写作上下文重新开始），避免 A 笔记指令污染 B 笔记。
- 气泡分色展示（写作模式独立配色）；切换时插入 banner：
  > 已切换为写作模式，该模式的上下文独立。切换回对话模式将保留各自历史。
- 会话-笔记解耦原则不破：会话不绑定笔记，单条消息携带笔记上下文。


### 4.3 上下文注入策略

- 注入笔记标题 + 正文全文；超过防御闸门（初始 20 万字符，可配）禁用写作模式，不做分块循环。
- LTM：保留 user_memory 注入，砍跨笔记 RAG 检索。

---

## 5. 工具协议（V1 三工具）

走 qwen3.7-plus 原生 Function Calling；写作模式下由后端注入 `tools` 参数。**V1 约束单轮最多一个 tool_call**（不启用并行工具调用），多步骤由 run 内多轮串行完成。

| 工具                  | 参数                  | 语义                                                                         |
| ------------------- | ------------------- | -------------------------------------------------------------------------- |
| `update_title`      | `new_title: string` | 整标题替换。前端持有旧标题（编辑器状态），撤销依赖单 history step                                    |
| `insert_at_cursor`  | `markdown: string`  | 在消息发送时快照的光标位置插入。空文档 → 纯插入；已有正文永不静默全文覆盖（prompt 约束只追加或引导用 replace_selection） |
| `replace_selection` | `markdown: string`  | 替换消息发送时快照的用户选区。无选区时降级：模型看到空选区上下文，改走对话澄清或 insert_at_cursor                  |

### 5.1 光标/选区上下文（随消息上行）

```jsonc
{
  "noteId": "string",
  "docHashAtSend": "string",                  // 消息发送瞬间的文档哈希（标题 + 正文），机器层守卫基准
  "selection": { "text": "string" } | null,   // 选中文本快照
  "cursorContext": {                           // 无选区时的光标锚点
    "beforeText": "string",                    // 光标前 ~200 字符
    "afterText": "string"                      // 光标后 ~200 字符
  } | null
}
```

选区与光标上下文在**消息发送瞬间快照**。整 run 锁保证快照在 run 期间不漂移；docHashAtSend 是该保证的**机器级守卫基准**：patch 应用前前端自比对当前文档哈希，不等则说明锁实现存在 bug 或竞态漏网，拒绝应用并按执行失败路径回传（见 §7.2）。

---

## 6. 消息模型与事件协议

**存储模型 ≠ SSE 传输格式 ≠ LLM 上下文格式。** 设计原则：DB 存全量事实，后端组装时投影、序列化成 qwen chat 消息结构（tool 消息 content 必须是字符串，由组装层 JSON.stringify）；content 字段保持"人可读文本"语义，工具载荷一律走结构化字段，不塞 JSON 字符串。

### 6.1 下行 SSE 事件集

现有 4 事件（已核实）+ 新增 3 类 + 保留 thinking：

| 事件             | 载荷                                              | 说明                                              |
| -------------- | ----------------------------------------------- | ----------------------------------------------- |
| `meta`         | 会话/消息元信息                                        | 现有，流起始                                          |
| `delta`        | 文本增量                                            | 现有，正文流式输出                                       |
| `done`         | —                                               | 现有，**回复轮的流终态**                                  |
| `error`        | 错误信息                                            | 现有                                              |
| `thinking`     | `{ content }`                                   | qwen3.7-plus thinking 分离输出，喂"思考中"状态（保留自 v1.0）   |
| `tool_call`    | `{ runId, toolCallId, tool, args }`             | LLM 决定调用工具。气泡展示工具名与目标；完整参数一次性推送（不做流式参数解析）       |
| `run_paused`   | `{ runId, reason: 'waiting_client_execution' }` | **tool_call 轮的流终态**（替代该轮的 done）：本轮流结束，等待客户端执行回传 |
| `run_finished` | `{ runId }`                                     | run 级终态，位于最后一轮流内、done 之前；前端收到即标记 run 完成、释放锁     |

**v1.0 事件的去向**：`tool_status` 删除——工具执行发生在 run_paused 之后的前端本地，"正在写入内容/正在更新标题"是**前端本地状态**（执行瞬间本地切换），不需要后端事件；`summary` 删除——收尾轮就是新一轮 SSE 流的正常文本输出（delta），总结模板由 prompt 约束，前端零特殊解析。工具摘要标注（"调用了 update_title 等 2 个工具"）由前端 join tool 消息渲染。

### 6.2 上行 tool_result（HTTP，非 SSE）

`POST /stream/chat/tool-result`：

```jsonc
{
  "sessionId": "string",
  "toolCallId": "string",              // 引用 assistant.toolCalls[].id
  "status": "applied" | "failed",      // cancelled 只由后端悬挂兜底合成，客户端不回传
  "docHash": "string",                 // 机器层字段：执行后文档哈希，组装模型上下文时剥离
  "titleAfter": "string",              // update_title 专用，供模型验证
  "error": "string"                    // failed 时：锚点失配等原因，模型据此修正重试
}
```

**不回传全文或新文本**——模型上下文里已有笔记全文（且有上下文缓存），回执只需确认成功。

**docHash 是机器层字段，不是模型信号**（v1.1 修订）：模型无法计算哈希，"感知版本漂移"只在理论上成立（字符串等值比较），且感知后没有行动路径——工具集里没有读文档的工具，模型无法重新取全文；整 run 锁又使 run 内漂移被结构性消灭，跨 run 漂移由每条写模式消息的全文注入天然覆盖。docHash 的真实价值在机器层：① 配合 §5.1 的 docHashAtSend 做锁失效守卫；② run 回放 / 撤销遥测对账（验证锁期间文档确实未变）。**组装 LLM messages 时剥离 docHash，不进入模型上下文。**

### 6.3 ChatMessage schema 定稿（单集合扩容）

```ts
interface ChatMessage extends Document {
  // 既有字段全部不动
  id: string;                          // mongodb ObjectId
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string;                     // 仅人可读文本；工具载荷不塞这里（toolCalls-only 内部轮可为空串）
  timestamp: number;
  msgId: string;                       // UUID v7，消息级唯一标识
  traceId: string;                     // 请求级追踪标识（每轮一次 LLM 调用一个新 traceId）
  isDeleted: boolean;

  // 新增① 上下文隔离
  mode?: 'chat' | 'write';             // 消息属于哪个上下文域（prompt 按此过滤）
  noteId?: string;                     // 写模式按笔记隔离；chat 模式为 null

  // 新增② 工具调用（assistant 消息）
  toolCalls?: Array<{
    id: string;                        // 模型生成的 toolCallId（如 call_xxx），tool 消息引用它
    name: 'update_title' | 'insert_at_cursor' | 'replace_selection';
    arguments: Record<string, unknown>;  // 结构化参数，前端直接执行，不 parse
  }>;

  // 新增③ 工具结果（role: 'tool' 消息）
  toolCallId?: string;                 // 引用 assistant.toolCalls[].id（与 msgId 溯源链正交的关联键）
  result?: {
    status: 'applied' | 'failed' | 'cancelled';  // cancelled = 悬挂兜底合成
    docHash?: string;                  // 机器层字段：锁失效守卫 + 观测对账，组装模型上下文时剥离
    titleAfter?: string;
    error?: string;                    // 失败原因，模型据此修正重试
  };

  // 新增④ run 关联
  runId?: string;                      // 一个 run 的多轮次共享；与 traceId 互补（run 级 vs 请求级聚合）
}
```

**为什么不加 display 字段**：`role: 'tool'` 本身就是内部性判别符，前端渲染天然只认 user/assistant——过滤成本在前端是免费的，在后端加布尔字段是冗余建模。全量存、全量回、前端过滤/聚合。

**为什么 tool 消息和工具轮不塞 content**：塞 JSON 会让前端渲染、执行 patch、历史展示全要 parse，脏且易错。tool 消息 content 为空串或一句排障摘要，权威数据在 result 字段，组装上下文时由后端序列化。

### 6.4 消息判别与渲染/组装规则

| 消息特征                                          | 判定                         | 前端渲染 / 后端组装                             |
| --------------------------------------------- | -------------------------- | --------------------------------------- |
| `role: 'user'`                                | 用户消息                       | 独立气泡                                    |
| `role: 'assistant'` 且 `toolCalls?.length > 0` | **工具内部轮**（无论 content 是否为空） | 不独立成气泡，归入同 runId 气泡的过程；组装上下文时全量携带       |
| `role: 'assistant'` 且无 toolCalls              | **回复轮**                    | 独立气泡；content 空 = 走既有故障呈现（无工具时代行为不变，零误伤） |
| `role: 'tool'`                                | 工具结果                       | 不独立渲染，按 toolCallId 归入对应 assistant 轮的过程  |

- **内部轮判据 = 结构化 `toolCalls` 字段存在性，不是 content 启发式**——无工具时代的故障消息不带 toolCalls，落第三行，行为与现状一致。
- **为什么不引入 system 或新 role 承载工具过程消息**：① `assistant + tool_calls` 是 OpenAI/qwen FC 协议层标准形态，模型发工具调用时就以该形态返回，DB 忠实记录、组装上下文零翻译成本，换 role 则每次组装要做反向映射；② `system` 在协议中是顶端系统提示词语义，且无 `tool_calls` 官方承载位，改用 system 只能把工具载荷塞回 content 的 JSON 字符串——已被否决的方案；③ Mnemo 的 system role 已有系统提示词/LTM 注入的用途，混入工具过程语义会造成一个 role 两种语义源的判别二义性。职责分离诉求已由"role=消息产生方 + toolCalls=是否含工具调用"的结构化字段表达满足。
- 组装上下文：以 mode + noteId 过滤取域，**工具过程消息（tool 轮 + toolCalls 轮）随其触发的用户消息整体携带**，不因 mode 过滤被拆散；run 内的多轮消息按时间序连续排列。
- 历史接口：全量返回（含 tool 消息与 toolCalls），前端按上表过滤与聚合；shape 保持 `{ success, data, message, timestamp, count? }`。全量返回的红利：V1.5 气泡级撤销要的 patch 元数据（旧标题/锚点）就在 `toolCalls.arguments` 里，回放时直接可用。
- 同 runId 的"用户消息 → 多轮 assistant/tool"聚合成一个用户可见气泡；回复轮（含总结）是气泡的主体文本。

---

## 7. 前端执行器（编辑器侧）

### 7.1 写入执行与回传

- patch 到达前端（tool_call 事件）后，编辑器内**单事务**执行（写入 + 高亮 Mark 一次完成），**单 history step**——一次 Ctrl+Z 整体撤销，Ctrl+Shift+Z 重做。
- 执行成功后立即 POST tool_result（applied + docHash），触发后端续轮。
- markdown → tiptap 节点转换沿用编辑器现有能力。

### 7.2 失败的两层（只有一层经过前端）

| 失败层                           | 谁发现           | 反馈路径                                                      | 频率                                   |
| ----------------------------- | ------------- | --------------------------------------------------------- | ------------------------------------ |
| 参数校验失败（工具名错 / schema 不符）      | 后端（续轮编排前）     | 后端**合成** tool_result 失败消息 → 直接续轮，不经过前端                    | 低（prompt/schema 约束）                  |
| 锁失效守卫（当前文档哈希 ≠ docHashAtSend） | 前端（patch 应用前） | 拒绝应用，前端回传 `{status:'failed', error:'doc drifted'}` → 续轮重试 | 极低（正常情况下被整 run 锁结构性排除，出现即说明锁实现有 bug） |
| 执行失败（锚点失配、光标上下文失效）            | 前端 tiptap     | 前端回传 `{status:'failed', error}` → 续轮，模型修正参数重发 tool_call   | 低（整 run 锁下更罕见，只剩坏锚点一种）               |

### 7.3 高亮与消散

- 自定义高亮 Mark 施加于 patch 内容；一次 mousedown 即消散；15 秒超时兜底自动淡出。

### 7.4 撤销信号埋点（HITL 遥测，保留自 v1.0）

每条 AI patch 消息记录**对应 history step 是否被用户撤销**（tiptap undo 事件可监听）。两周撤销率数据驱动"是否升级写入前审批 / 是否开放免审"，不拍脑袋。埋点落消息 meta，不建新集合。

---

## 8. AI 对话框（AiChatWindow 侧）

### 8.1 气泡状态机（跨轮次）

```
idle → thinking（thinking 事件，沿用现有占位样式）
     → tool_call（展示工具名与目标，气泡生长）
     → run_paused → 前端执行（本地 tool_status：正在写入内容/更新标题）
     → POST tool_result → [续轮，气泡继续生长]
     → … → 收尾轮 delta（事实总结）→ run_finished → 气泡定格
```

- 纯对话回复（无工具）走现有 delta 路径，零变化。
- 写作模式气泡分色；**run 进行中发送框禁用 + "取消本次"出口**。
- 取消 / 中断 / 失败的呈现：run 无可见收尾时后端补失败说明（§3.5）；正常收尾则总结文本 + 工具摘要标注。

### 8.2 回放呈现（切回旧会话时）

- 只显示 user + 回复轮正文（含总结）；工具过程不渲染过程卡。
- 回复轮气泡底部**折叠摘要标注**：如"调用了 update_title 等 2 个工具，均已生效"——前端 join 该 runId 下 tool 消息的状态后渲染，成本低。
- 内部轮（assistant+toolCalls）不独立成气泡，无收尾轮的孤儿 run 由后端补的可见消息兜底。

### 8.3 总结模板

收尾轮文本由 prompt 约束固定模板（非自由发挥），参考：

```
已完成更新：
- 文档标题栏已从空填写为「队列死信机制（Dead Letter Queue, DLQ）」
- 正文重复的 h1 标题已删除，避免与文档标题栏重复
- 现在文档结构清晰：顶部标题栏显示大标题，正文直接从「一、什么是死信队列」开始
```

工具级摘要（"调用了 X 个工具，均已生效"）由前端结构化渲染，LLM 文本总结只负责语义说明，两者不重叠。

---

## 9. 已知盲区与后续路线

| 项                                       | 状态       | 说明                                                                           |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| 手动编辑后 Ctrl+Shift+Z 无法恢复 AI 内容           | V1 已知并接受 | native redo 依赖历史栈连续；V1.5 气泡级"撤销此修改"基于 toolCalls.arguments 元数据显式逆操作解决         |
| run 级单步撤销（一次 Ctrl+Z 回滚整个 run 的多个 patch） | 增强项      | V1 为 per-tool step（可逐块反悔）；run 级分组需自定义 tiptap history meta，记入 V1.5 patch 日志气泡 |
| 全文批处理任务（如"全文改书面语"）                      | V2       | 依赖 edit_block 与任务拆解                                                          |
| 接受率免审降级 / 审批升级                          | 待数据      | 两周撤销率遥测后决策（§7.4）                                                             |

---


## 10. 决策记录

| #  | 决策点         | 结论                                                                                                                                                                                                   | 轮次    |
| -- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1  | 工具集         | update_title / insert_at_cursor / replace_selection；块级修改、覆盖、删除推 V2                                                                                                                                   | R1    |
| 2  | 入口策略        | 显式写作模式 chip，消息级携带 noteId + 光标/选区上下文                                                                                                                                                                  | R1    |
| 3  | 并发冲突        | 生成期间锁编辑区（v1.1 延伸为整 run 锁，见 #12）                                                                                                                                                                      | R1→R4 |
| 4  | 工具协议        | qwen3.7-plus 原生 Function Calling（已核实支持）                                                                                                                                                              | R1→R2 |
| 5  | 长笔记         | 全文注入 + 20 万字符防御闸门；分块循环编辑否决                                                                                                                                                                           | R2    |
| 6  | 双上下文        | 单消息流 + mode 字段；气泡分色 + 切换 banner；写上下文按 noteId 隔离                                                                                                                                                      | R2    |
| 7  | 写模式检索       | 保留 user_memory 注入，砍跨笔记 RAG                                                                                                                                                                           | R2    |
| 8  | 撤销          | V1 原生 Ctrl+Z / Ctrl+Shift+Z；气泡级逆操作推 V1.5                                                                                                                                                             | R2    |
| 9  | HITL 审批流    | 不做写入前审批/diff 展示；以撤销信号埋点替代数据采集，后续按数据升级                                                                                                                                                                | R3    |
| 10 | 版本 stack    | 不做；V1.5 以 AI patch 日志覆盖真实盲区                                                                                                                                                                          | R3    |
| 11 | 执行位置        | **前端执行器 + 观察回传（方案 B）**；否决后端直写 DB（方案 C）：双写者冲突 + 反向同步深水区 + 索引管线绕过 + 版本管理                                                                                                                               | R4    |
| 12 | MVP 档位      | Tier 2 直上：完整 agent loop（run_paused → tool_result → 续轮 → 失败重试 → 事实总结）                                                                                                                                 | R4    |
| 13 | loop 载体     | 消息历史即 agent 状态，零内存状态、无需 Redis、刷新不丢                                                                                                                                                                   | R4    |
| 14 | 锁策略         | 整 run 锁（到 run_finished / 取消）；逐轮锁否决                                                                                                                                                                   | R4    |
| 15 | 失败两层        | 参数校验失败后端合成直续轮（不经前端）；执行失败前端回传 failed 修正重试                                                                                                                                                             | R4    |
| 16 | 传输          | 专用 POST /stream/chat/tool-result 内联续轮 SSE                                                                                                                                                            | R4    |
| 17 | 撤销粒度        | per-tool step；run 级分组记增强项                                                                                                                                                                            | R4    |
| 18 | 悬挂兜底        | 末位 tool_call 无后继结果 → 后端合成 cancelled 追加（上下文完整性）                                                                                                                                                       | R4    |
| 19 | 事件集收敛       | 现有 4 + thinking/tool_call/run_paused/run_finished；tool_status 降前端本地态、summary 由收尾轮取代；砍 tool_call_delta / message_delta                                                                                | R4→R5 |
| 20 | 载荷存储        | toolCalls / result 走结构化字段，content 保持人可读文本；tool 消息 content 不塞 JSON                                                                                                                                    | R5    |
| 21 | runId       | 加（run 级观测口径，与请求级 traceId 互补）                                                                                                                                                                         | R5    |
| 22 | display 字段  | **不加**（role='tool' 即内部性判别符；全量存全量回，前端过滤免费）                                                                                                                                                            | R5    |
| 23 | 内部轮判据       | 结构化 `toolCalls?.length > 0`，不用 content==='' 启发式（避免误吞无工具时代故障消息）                                                                                                                                       | R5    |
| 24 | 回放呈现        | 折叠摘要标注（"调用了 X 个工具"），不渲染过程卡                                                                                                                                                                           | R5    |
| 25 | run 可见性兜底   | run 结束时后端校验可见 assistant 消息存在性，无则补失败说明（用户可感知性）                                                                                                                                                        | R5    |
| 26 | docHash 定位  | **机器层字段，不是模型信号**：模型无法计算哈希、感知漂移后亦无行动路径（无读文档工具），且整 run 锁消灭 run 内漂移、全文注入覆盖跨 run 漂移。保留用于锁失效守卫（消息上行 docHashAtSend + patch 应用前前端自比对）与观测对账；组装模型上下文时剥离                                                       | R6    |
| 27 | 工具过程消息 role | 维持 `role: 'assistant'` + toolCalls 判据，不引入 system/新 role 承载：`assistant + tool_calls` 是 OpenAI/qwen FC 协议标准形态（忠实记录、组装零翻译）；system 是顶端系统提示词语义且无 tool_calls 承载位；system 已有系统提示词/LTM 用途，混入会产生一 role 两语义的二义性 | R7    |
