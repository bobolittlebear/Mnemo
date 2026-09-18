import mongoose, { Schema, Document } from 'mongoose';
/** 笔记本 */
export interface Notebook extends Document {
    title: string;
    createUser: string;
    updateUser: string;
    createdAt: Date;
    updatedAt: Date;
    isDeleted: boolean; // 软删除标识位
}
/** 笔记 */
export type Note = {
    notebookId: mongoose.Types.ObjectId;
    title: string;
    content: string;
    createUser: string;
    updateUser: string;
    isDeleted: boolean;
};

/** 会话消息 */
export interface ChatMessage extends Document {
    id: string; // mongodb ObjectId 自动生成
    sessionId: string; // 关联会话的唯一标识（无前缀 sessionId）
    role: 'system' | 'user' | 'assistant' | 'tool' | string;
    content: string; // 消息内容
    timestamp: number; // 消息发送的时间戳（毫秒）
    msgId: string; // UUID v7，消息级唯一标识 ← sourceMessageIds 引用这个
    traceId: string; // 请求级追踪标识 ← 保留，继续用于全链路追踪
    isDeleted: boolean; // 软删除标识

    // ── 工具调用链路扩容（.claude/design/tool-calling/tool-calling-detail.md §6.3）──
    // 均为可选：Mongoose 的 SchemaDefinition<T> 严格映射 keyof T，schema 新增路径必须在此声明
    mode?: 'chat' | 'write'; // 消息归属的上下文域，prompt 按此过滤
    noteId?: string; // 写模式按笔记隔离；chat 模式不写
    toolCalls?: Array<{
        id: string; // 模型生成的 toolCallId，tool 消息引用它
        name: string; // 工具名（schema 层为 String，未做 enum 约束）
        arguments: Record<string, unknown>; // 结构化参数，前端直接执行不 parse
    }>;
    toolCallId?: string; // 引用 assistant.toolCalls[].id
    result?: {
        status: 'applied' | 'failed' | 'cancelled'; // cancelled = 悬挂兜底合成
        docHash?: string; // 锁失效守卫 + 观测对账；组装模型上下文时剥离
        titleAfter?: string;
        error?: string; // 失败原因，模型据此修正重试
    };
    runId?: string; // 一个 run 的多轮次共享，与请求级 traceId 互补
}

/** 长期记忆的语义分类枚举 (对应 Prompt 的扩展) */
type MemoryCategory =
    | 'preference'
    | 'personal_info'
    | 'decision'
    | 'behavior_pattern'
    | 'relationship'
    | 'diet'
    | 'skill'
    | 'goal'
    | 'event'
    | 'instruction'
    | string;

type MetaData = {
    // 可观测性追踪
    tracing?: {
        traceIds: string[]; // 生成该记忆涉及的 LLM 调用 traceId
        // spanIds?: string[]; // 未来可能需要更细粒度的 span
    };

    // 记忆质量标注（未来扩展）
    quality?: {
        confidenceScore?: number; // RRF 融合分数 or rerank 分数
        compressionRatio?: number; // 原始消息数 / 记忆条数
        feedbackLabel?: 'good' | 'bad' | 'irrelevant'; // 用户反馈
    };

    // 来源上下文（未来扩展）
    source?: {
        modelId?: string; // 生成摘要的模型
        embeddingModelVersion?: string; // 向量化所用模型版本
    };
} & Record<string, any>;

/** 长期记忆 */
export interface MemoryFact extends Document {
    userId: string;
    content: string;
    searchText?: string; // 分词后的搜索文本，用于中文全文检索
    sourceMessageIds: string[]; // 对应的源消息ID
    embedding?: number[];
    confidence: number;
    createdAt: Date;
    updatedAt: Date;
    notebookId?: string; // 笔记本隔离（可选，兼容全局记忆null）
    // 区分对话事实与笔记分块，便于差异化检索；预留 media 类型，未来支持图文检索
    type: 'fact' | 'note_chunk' | 'media';
    contentHash?: string; // 内容指纹，用于语义去重（防止相似事实重复入库）
    metadata?: MetaData; // 元数据预留扩展字段
    // 预留字段
    mediaUrl?: string; // 预留媒体资源地址
    mediaType?: 'image' | 'audio' | 'video'; // 预留媒体类型

    // 语义类型
    category?: MemoryCategory;

    // 软删除
    deletedAt?: Date;

    // 最后一次被实质使用（检索命中 / 入库 / 提取更新）的时间，遗忘机制判定依据
    // 可选：存量记忆无此字段属正常状态
    lastSignificantAt?: Date;
}

/** 笔记分块（父子块，独立于 MemoryFact 的集合） */
export interface NoteChunk extends Document {
    noteId: mongoose.Types.ObjectId; // 所属笔记
    notebookId: mongoose.Types.ObjectId; // 所属笔记本
    userId: string;
    title: string; // 块标题（取自最近的标题层级）
    chunkType: 'parent' | 'child'; // parent=标题父块，child=正文子块
    parentId?: mongoose.Types.ObjectId; // 自引用 NoteChunk（child → parent）
    sectionPath: string[]; // 标题层级路径
    chunkIndex: number; // 0-based 全局顺序
    content: string; // 块正文
    embedding?: number[]; // 向量（仅 child 块生成）
    searchText: string; // 分词后的搜索文本，用于中文全文检索
    contentHash: string; // 内容指纹，用于去重
    createdAt: Date;
    updatedAt: Date;
}
