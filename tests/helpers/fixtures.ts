/**
 * 测试数据工厂 — 构造各测试用例所需的 Mock 数据
 */

// ── 对话消息 ──
const now = Date.now();
export const mockMessages = [
    {
        id: 'msg-001',
        role: 'user' as const,
        content: '我目前在准备前端面试，重点复习 React 和 TypeScript。',
        msgId: 'msg-001',
        timestamp: now,
    },
    {
        id: 'msg-002',
        role: 'assistant' as const,
        content:
            '好的，我帮你整理 React 高频面试题。先从 hooks 开始：useState、useEffect、useMemo 的区别是什么？',
        msgId: 'msg-002',
        timestamp: now,
    },
    {
        id: 'msg-003',
        role: 'user' as const,
        content:
            '我目前在杭州，有 3 年前端经验，主要技术栈是 React + TypeScript。',
        msgId: 'msg-003',
        timestamp: now,
    },
];

export const emptyMessages: any[] = [];

export const singleMessage = [
    {
        id: 'msg-solo',
        role: 'user' as const,
        content: '今天天气不错',
    },
];

// ── LLM 返回值 ──

/** LLM 正常返回的 JSON */
export const llmNormalResponse = {
    content: JSON.stringify({
        facts: [
            {
                content: '用户在准备前端面试，重点复习 React 和 TypeScript',
                confidence: 0.9,
            },
            {
                content: '用户在杭州，有 3 年前端经验',
                confidence: 0.85,
            },
            {
                content: '用户主要技术栈是 React + TypeScript',
                confidence: 0.8,
            },
        ],
    }),
};

/** LLM 返回带 markdown 包裹的 JSON */
export const llmMarkdownWrappedResponse = {
    content:
        '```json\n' +
        JSON.stringify({
            facts: [{ content: '这是一条测试事实', confidence: 0.9 }],
        }) +
        '\n```',
};

/** LLM 返回空 facts */
export const llmEmptyFactsResponse = {
    content: JSON.stringify({ facts: [] }),
};

/** LLM 返回非法 JSON */
export const llmInvalidJsonResponse = {
    content: '这不是一个JSON格式的字符串',
};

/** LLM 返回字段类型错误 */
export const llmWrongTypeResponse = {
    content: JSON.stringify({
        facts: [
            { content: 123, confidence: 'high' }, // 类型错误
            { content: '这是一条正常的事实', confidence: 0.9 }, // >= 5 字符，能通过长度过滤
        ],
    }),
};

/** LLM 返回低置信度事实 */
export const llmLowConfidenceResponse = {
    content: JSON.stringify({
        facts: [
            { content: '高置信度事实', confidence: 0.9 },
            { content: '低置信度事实', confidence: 0.3 },
            { content: '边界置信度事实', confidence: 0.59 },
        ],
    }),
};

/** LLM 返回清洗后过短的内容 */
export const llmShortContentResponse = {
    content: JSON.stringify({
        facts: [
            { content: 'ab', confidence: 0.9 }, // 2 字符
            { content: 'abc', confidence: 0.9 }, // 3 字符
            { content: 'abcd', confidence: 0.9 }, // 4 字符
            { content: '正常长度的事实内容', confidence: 0.9 },
        ],
    }),
};

/** LLM 返回需要清洗的内容 */
export const llmDirtyContentResponse = {
    content: JSON.stringify({
        facts: [
            {
                content: '  这段   内容\t\n有\n\n多余空白  ',
                confidence: 0.9,
            },
            {
                content: '带有\x00控制\x01字符\x7f的内容',
                confidence: 0.9,
            },
        ],
    }),
};

// ── Embedding 返回值 ──

export const mockEmbeddings = {
    embeddings: [
        [0.1, 0.2, 0.3, 0.4, 0.5],
        [0.6, 0.7, 0.8, 0.9, 1.0],
        [0.11, 0.22, 0.33, 0.44, 0.55],
    ],
};

export const emptyEmbeddings = { embeddings: [] };

// ── bulkWrite 返回值 ──

export const mockBulkWriteResult = {
    insertedCount: 3,
    modifiedCount: 0,
    upsertedCount: 0,
    deletedCount: 0,
    matchedCount: 3,
};

export const mockBulkWriteUpdateResult = {
    insertedCount: 1,
    modifiedCount: 2,
    upsertedCount: 0,
    deletedCount: 0,
    matchedCount: 3,
};

// ── 上下文 ──

export const mockSessionId = 'test-session-001';
export const mockMemoryKey = 'mnemo:extraction:test-session-001';
export const mockNotebookId = 'notebook-001';
