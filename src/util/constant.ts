export const UNKNOWN_ERROR = '未知错误';
export const RENEW_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7*24小时，单位为毫秒
export const MAX_CHECK_LENGTH = 50;

export const SESSION_KEY_PREFIX = 'quick_note:session:'; // 记忆管理memory key的前缀
export const LAST_EXTRACTED_MSG_KEY_PREFIX = 'quick_note:extract:';
export const MAX_MESSAGE_PER_SESSION = 100;
export const SESSION_TTL_SECONDS = 60 * 60; // Redis TTL 以秒为单位，60分钟

export const TIMEOUT_MS = 100;

export const COOKIE_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week
export const COOKIE_MEMORY_KEY_MAX_AGE = 24 * 60 * 60 * 1000; // 24 小时

/** 从会话消息提取长期记忆的 Prompt */
export const EXTRACTION_PROMPT = `你是一个记忆提取专家。请从以下对话中提取用户的长期记忆。

========================
1. 当前上下文
========================
用户ID: {{USER_ID}}
对话时间范围: {{CONVERSATION_TIME_RANGE}}
已有记忆（供参考去重、更新、矛盾检测）:
{{EXISTING_MEMORIES}}

========================
2. 记忆类型定义
========================
| category       | 说明                 | 示例                          |
|----------------|----------------------|-------------------------------|
| preference     | 偏好/喜好            | 用户偏好 TypeScript            |
| personal_info  | 身份/背景/个人信息   | 用户住北京、是后端开发者       |
| decision       | 重要决定/承诺        | 用户决定用 React 重写前端     |
| behavior_pattern | 行为习惯/模式      | 用户习惯晚上学习、周末实践     |
| relationship   | 对他人的评价/关系    | 用户觉得张三代码质量不错       |
| diet           | 饮食习惯             | 用户吃素                       |
| skill          | 技能/能力            | 用户掌握 Python 和 Go          |
| goal           | 目标/计划            | 用户计划三个月内转型 AI 全栈   |
| event          | 重要事件             | 用户上周搬到了上海             |

========================
3. 提取与清洗规则（逐条检查，违反则丢弃）
========================
清理：
  - 补全主语：统一以"用户"或具体名字作为主语，消除代词（他/它/他们/这个/那个）
  - 客观陈述句：消除口语化语气词（吧/啦/咯/哈/呢）、冗余修饰（感觉/我觉得/说实话/讲真）
  - 去噪音：合并连续空白字符、去除 emoji、去除特殊符号（保留中文和基本标点：，。！？、；：""''）
  - 含时态：如有时态信息保留（"用户目前…"、"用户计划…"、"用户曾经…"）

排除（遇到这些直接跳过）：
  - 临时情绪/状态："今天好累"、"好开心"
  - 无意义寒暄："吃饭了吗"、"好的"
  - 不含主体信息的闲聊："今天天气不错"
  - 系统消息/纯技术日志

========================
4. 版本控制与冲突处理（优先级最高）
========================
对比提取结果与"已有记忆"，对每条候选事实执行以下判定：

| 条件 | action | 说明 |
|---|---|---|
| 全新事实，与已有记忆无对应关系 | ADD | old_memory 填 null |
| 语义一致但需更新/补充/替换（如从A换成B，或补充细节） | UPDATE | 必须填 old_memory（旧文本）和 content（新文本） |
| 彻底失效且无替代物（如"我不再养猫了"、"已经离职"） | DELETE | 必须填 old_memory。content 填状态描述（如"用户不再养猫"） |
| 与已有记忆语义重复且无明显变更 | 跳过不输出 | 去重，不要输出该条 |


========================
5. 置信度锚点（严格执行）
========================
| 置信度范围 | 适用条件 |
|---|---|
| 0.9 - 1.0 | 用户明确、无歧义地陈述 |
| 0.7 - 0.89 | 合理推断、连续上下文暗示 |
| 0.5 - 0.69 | 间接暗示、随口一说、不确定 |

⚠️ 强制规则：
1. 如果置信度 < 0.5，直接丢弃，绝对不要输出。
2. 输出的 confidence 值必须严格落在上述三个区间内（如 0.95, 0.8, 0.6），禁止输出区间外的值（如 0.4, 0.895, 0.755）。

========================
6. Few-Shot 示例（个人笔记场景，共 3 例）
========================

【示例 1 — 学习笔记 → ADD 多种类别】（最常见场景）
笔记：
  "今天终于搞懂了 Transformer 的注意力机制。之前看论文总是卡在 QKV 那块，
   今天照着 3Blue1Brown 的可视化视频一步一步推，豁然开朗。接下来准备把
   Attention is All You Need 复现一遍，再刷几道 LeetCode 巩固基础。
   发现视频学习比看书效率高很多，以后学新东西优先找视频。"

已有记忆：["用户从事后端开发", "用户正在学习机器学习"]

正确输出：
{
  "facts": [
    {
      "action": "ADD",
      "content": "用户通过 3Blue1Brown 视频理解了 Transformer 注意力机制",
      "old_memory": null,
      "confidence": 0.95,
      "category": "skill",
      "source_time": "2026-07"
    },
    {
      "action": "ADD",
      "content": "用户计划复现 Attention is All You Need 论文",
      "old_memory": null,
      "confidence": 0.9,
      "category": "goal",
      "source_time": "2026-07"
    },
    {
      "action": "ADD",
      "content": "用户偏好视频学习，认为比看书效率高",
      "old_memory": null,
      "confidence": 0.85,
      "category": "preference",
      "source_time": "2026-07"
    },
    {
      "action": "ADD",
      "content": "用户在学习 Transformer 时 QKV 部分遇到困难，通过视频可视化克服",
      "old_memory": null,
      "confidence": 0.8,
      "category": "behavior_pattern",
      "source_time": "2026-07"
    }
  ]
}

【示例 2 — 日记 → UPDATE 行为模式】
笔记：
  "一个月的作息调整实验结束了。之前一直是夜猫子，凌晨两点睡、十点起，
   试了试十一点睡、七点起。前三周每天都想放弃，但坚持下来发现上午效率真的高，
   一天能干以前一天半的活。打算后面就这样保持，但周末偶尔可以放纵晚睡。"

已有记忆：["用户习惯晚睡，作息不规律"]

正确输出：
{
  "facts": [
    {
      "action": "UPDATE",
      "old_memory": "用户习惯晚睡，作息不规律",
      "content": "用户成功调整作息为 23:00-07:00，上午工作效率显著提升，计划长期保持（周末允许偶尔放纵）",
      "confidence": 0.95,
      "category": "behavior_pattern",
      "source_time": "2026-07"
    },
    {
      "action": "ADD",
      "content": "用户发现上午工作时间比晚上效率高",
      "old_memory": null,
      "confidence": 0.9,
      "category": "preference",
      "source_time": "2026-07"
    }
  ]
}

【示例 3 — 工作笔记 → DELETE 技术栈】（最有区分度的操作）
笔记：
  "项目架构评审。原先计划继续用 Express，但考虑到后续要接入 AI Agent
   和数据流复杂度，决定迁移到 NestJS + TypeScript。先走 /beta 并行跑，
   等稳定再全量切。数据库从 MongoDB 迁到 PostgreSQL + Prisma ORM。"

已有记忆：["用户项目使用 Express + MongoDB"]

正确输出：
{
  "facts": [
    {
      "action": "UPDATE",
      "old_memory": "用户项目使用 Express + MongoDB",
      "content": "用户项目框架从 Express 迁移至 NestJS + TypeScript",
      "confidence": 0.95,
      "category": "decision",
      "source_time": "2026-07"
    },
    {
      "action": "DELETE",
      "old_memory": "用户项目使用 Express + MongoDB",
      "content": "用户项目数据库从 MongoDB 迁移至 PostgreSQL + Prisma ORM",
      "confidence": 0.95,
      "category": "decision",
      "source_time": "2026-07"
    },
    {
      "action": "ADD",
      "content": "用户团队采用 /beta 并行路径策略进行架构迁移",
      "old_memory": null,
      "confidence": 0.85,
      "category": "behavior_pattern",
      "source_time": "2026-07"
    }
  ]
}


========================
7. 对话内容
========================
{{CONVERSATION}}

========================
8. 输出要求
========================
仅返回 JSON，不要输出任何其他内容：
{
  "facts": [
    {
      "action": "ADD | UPDATE | DELETE",
      "content": "事实文本（客观陈述句、完整主语）",
      "old_memory": "被取代/删除的已有记忆原文（ADD 时为 null）",
      "confidence": 0.0 - 1.0,
      "category": "上述 category 之一",
      "source_time": "年月或 'unknown'"
    }
  ]
}
如果没有值得记忆的内容，返回 {"facts": []}。`;
