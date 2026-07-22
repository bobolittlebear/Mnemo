export const UNKNOWN_ERROR = '未知错误';
export const RENEW_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7*24小时，单位为毫秒
export const MAX_CHECK_LENGTH = 50;

export const DEFAULT_API_CONFIG = {
    MAX_RETRIES: 3,
    BASE_DELAY: 1000,
    MAX_DELAY: 10_000,
};

export const TRACE_ID_PREFIX = 'trace-';
export const MESSAGE_ID_PREFIX = 'msg-';
export const SESSION_KEY_PREFIX = 'quick_note:session:'; // 记忆管理会话标识 session key的前缀
export const MAX_MESSAGE_PER_SESSION = 100;
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // Redis TTL 以秒为单位，60分钟/先改为30天用于测试呢

export const REDIS_READ_TIMEOUT_MS = 300;

export const COOKIE_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week
export const COOKIE_MEMORY_KEY_MAX_AGE = 24 * 60 * 60 * 1000; // 24 小时

/** 从会话消息提取长期记忆的 Prompt */
export const EXTRACTION_PROMPT = `你是记忆提取专家。从以下对话中提取用户的长期记忆。

# 1. 上下文
用户ID: {{USER_ID}}
对话时间范围: {{CONVERSATION_TIME_RANGE}}
已有记忆（用于去重/更新/矛盾检测）:
{{EXISTING_MEMORIES}}

# 2. 记忆类别
| category | 说明 | 示例 |
|---|---|---|
| preference | 偏好/喜好 | 用户偏好 TypeScript |
| personal_info | 身份/背景 | 用户住北京、后端开发者 |
| decision | 重要决定/承诺 | 用户决定用 React 重写前端 |
| behavior_pattern | 行为习惯/模式 | 用户习惯晚上学习 |
| relationship | 对他人评价/关系 | 用户觉得张三代码质量不错 |
| diet | 饮食习惯 | 用户吃素 |
| skill | 技能/能力 | 用户掌握 Python 和 Go |
| goal | 目标/计划 | 用户计划三个月内转型 AI 全栈 |
| event | 重要事件 | 用户上周搬到上海 |

# 3. 提取与清洗规则
清洗：
- 补全主语：统一用"用户"或具体名字，消除代词（他/它/他们/这个/那个）
- 客观陈述句：去语气词（吧/啦/咯/哈/呢）、冗余修饰（感觉/我觉得/说实话/讲真）
- 去噪音：合并空白、去 emoji、去特殊符号（保留中文与基本标点：，。！？、；：""''）
- 含时态：保留时态信息（"用户目前…"、"用户计划…"、"用户曾经…"）

排除（直接跳过）：
- 临时情绪/状态："今天好累"、"好开心"
- 无意义寒暄："吃饭了吗"、"好的"
- 无主体信息的闲聊："今天天气不错"
- 系统消息/纯技术日志

# 4. 版本控制与冲突处理（优先级最高）
对每条候选事实，对比已有记忆执行判定：
| 条件 | action | 说明 |
|---|---|---|
| 全新事实，无对应关系 | ADD | old_memory 填 null |
| 语义一致但需更新/补充/替换 | UPDATE | 必须填 old_memory 和 content |
| 彻底失效且无替代物（如"已离职"、"不再养猫"） | DELETE | 必须填 old_memory，content 填状态描述 |
| 与已有记忆语义重复且无变更 | 跳过 | 不输出 |

# 5. 置信度锚点
| 范围 | 适用条件 |
|---|---|
| 0.9-1.0 | 用户明确、无歧义陈述 |
| 0.7-0.89 | 合理推断、上下文暗示 |
| 0.5-0.69 | 间接暗示、随口一说、不确定 |

强制规则：
1. 置信度 < 0.5 直接丢弃，不输出
2. confidence 必须严格落在上述三区间内（如 0.95/0.8/0.6），禁止区间外值（如 0.4/0.895/0.755）

# 6. Few-Shot 示例

【示例 1 — 学习笔记 → ADD 多类别】
笔记："今天终于搞懂 Transformer 注意力机制。之前看论文总卡在 QKV，今天照 3Blue1Brown 可视化视频一步步推，豁然开朗。接下来准备复现 Attention is All You Need，再刷几道 LeetCode 巩固基础。发现视频学习比看书效率高很多，以后学新东西优先找视频。"
已有记忆：["用户从事后端开发","用户正在学习机器学习"]

输出：
{
  "facts": [
    {"action":"ADD","content":"用户通过 3Blue1Brown 视频理解了 Transformer 注意力机制","old_memory":null,"confidence":0.95,"category":"skill","source_time":"2026-07"},
    {"action":"ADD","content":"用户计划复现 Attention is All You Need 论文","old_memory":null,"confidence":0.9,"category":"goal","source_time":"2026-07"},
    {"action":"ADD","content":"用户偏好视频学习，认为比看书效率高","old_memory":null,"confidence":0.85,"category":"preference","source_time":"2026-07"},
    {"action":"ADD","content":"用户学习 Transformer 时 QKV 部分遇到困难，通过视频可视化克服","old_memory":null,"confidence":0.8,"category":"behavior_pattern","source_time":"2026-07"}
  ]
}

【示例 2 — 日记 → UPDATE 行为模式】
笔记："一个月作息调整实验结束。之前是夜猫子（凌晨2点睡10点起），试了11点睡7点起。前三周每天想放弃，坚持下来发现上午效率真的高，一天能干以前一天半的活。打算后面就这样保持，但周末偶尔可以放纵晚睡。"
已有记忆：["用户习惯晚睡，作息不规律"]

输出：
{
  "facts": [
    {"action":"UPDATE","old_memory":"用户习惯晚睡，作息不规律","content":"用户成功调整作息为 23:00-07:00，上午工作效率显著提升，计划长期保持（周末允许偶尔放纵）","confidence":0.95,"category":"behavior_pattern","source_time":"2026-07","sourceMessageIds":["msg-abc123efg456"]},
    {"action":"ADD","content":"用户发现上午工作时间比晚上效率高","old_memory":null,"confidence":0.9,"category":"preference","source_time":"2026-07","sourceMessageIds":["msg-abc123efg455"]}
  ]
}

【示例 3 — 工作笔记 → UPDATE + DELETE】
笔记："项目架构评审。原先计划继续用 Express，但考虑后续要接入 AI Agent 和数据流复杂度，决定迁移到 NestJS + TypeScript。先走 /beta 并行跑，稳定再全量切。数据库从 MongoDB 迁到 PostgreSQL + Prisma ORM。"
已有记忆：["用户项目使用 Express + MongoDB"]

输出：
{
  "facts": [
    {"action":"UPDATE","old_memory":"用户项目使用 Express + MongoDB","content":"用户项目框架从 Express 迁移至 NestJS + TypeScript","confidence":0.95,"category":"decision","source_time":"2026-07","sourceMessageIds":["msg-abc123efg454","msg-abc123efg455"]},
    {"action":"DELETE","old_memory":"用户项目使用 Express + MongoDB","content":"用户项目数据库从 MongoDB 迁移至 PostgreSQL + Prisma ORM","confidence":0.95,"category":"decision","source_time":"2026-07","sourceMessageIds":["msg-abc123efg456"]},
    {"action":"ADD","content":"用户团队采用 /beta 并行路径策略进行架构迁移","old_memory":null,"confidence":0.85,"category":"behavior_pattern","source_time":"2026-07","sourceMessageIds":["msg-abc123efg457"]}
  ]
}

# 7. 对话内容
{{CONVERSATION}}

# 8. 输出要求
仅返回 JSON，不要输出其他内容：
{
  "facts": [
    {
      "action": "ADD | UPDATE | DELETE",
      "content": "事实文本（客观陈述句、完整主语）",
      "old_memory": "被取代/删除的已有记忆原文（ADD 时为 null）",
      "confidence": 0.0-1.0,
      "category": "上述类别之一",
      "source_time": "年月或 'unknown'",
      "sourceMessageIds": ["msg_id", ...]
    }
  ]
}
- sourceMessageIds 必须来自对话中真实的 [msg_id:xxx]，禁止编造；多消息综合推理时列出所有相关 ID
- 不含可提取事实的消息不要为其生成条目
- 无值得记忆内容时返回 {"facts": []}`;
