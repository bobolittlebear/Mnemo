// src/utils/queryExpansion.ts
// 查询展开（query-expansion）：用一份人工策划的静态同义词表，把口语化 / 同义改写的 query
// 表述扩展为目标领域术语，扩展串同时喂给向量路（generateEmbedding）与 BM25 路（textSearch），
// 缓解「query 用口语、文档用术语」的表达空间错位导致的漏召回（如 q_l2_para 的
// 「很久没说话」↔ 文档「L2 超时触发」）。
//
// 设计约束（M2，见 .claude/design/note-rag-tuning.md §2）：
// - 纯静态数据 + 纯函数：零 IO、零 LLM 调用、零新依赖（匹配用 String.includes，不依赖 jieba）；
// - 只追加不替换（保留原 query 的全部信号），且只跑一遍——不在扩展结果上二次展开，避免膨胀 / 递归；
// - 表保持精简、可增不可滥：每加一条都需在 tests/evals 的召回评测上验证净正面（零退化）。
//
// 不接入点：不改动 rrfFuse 融合、candidateLimit、domainWords / tokenizer 词典机制。

export interface SynonymEntry {
    /** 触发短语：query 中出现的口语化 / 同义表述（精确子串匹配） */
    match: string;
    /** 命中后追加到 query 尾部的领域术语 */
    expand: string[];
}

/**
 * 静态同义词表（口语 / 同义 → 领域术语）。
 *
 * 条目按「触发短语」拆开而非合并成同义词组，是为了保持 match 语义单一、便于逐条增删与回滚；
 * 多条命中的重复扩展词由 expandQuery 统一去重。
 */
export const SYNONYM_TABLE: ReadonlyArray<SynonymEntry> = [
    // 口语「很久没说话」→ LTM 三层触发里的 L2 空闲超时收尾（q_l2_para 盲区）
    { match: '很久没说话', expand: ['超时', '静默', 'L2', '超时触发'] },
    { match: '很久不说话', expand: ['超时', '静默', 'L2', '超时触发'] },
    // 口语「存成长期记忆」→ LTM 提取 / L2 触发（同 q_l2_para）
    { match: '存成长期记忆', expand: ['记忆提取', 'L2', '触发', '自动提取'] },
    { match: '长期记忆', expand: ['记忆提取', 'L2', '触发', '自动提取'] },
    // 口语「切分」→ 分块术语（q_rag_para）
    { match: '切分', expand: ['分块', '切片', 'chunk'] },
    // 口语「向量化」→ 向量 / 嵌入术语（q_rag_para）
    { match: '向量化', expand: ['embedding', '嵌入'] },
    // 口语「向量库 / 向量检索」→ 语义检索（q_rag_para）
    { match: '向量库', expand: ['语义检索', 'embedding'] },
    { match: '向量检索', expand: ['语义检索', 'embedding'] },
    // 口语「分块切得好不好」→ 分块质量评测术语（q_chunk_para 盲区）
    { match: '分块切得好不好', expand: ['chunk', '质量', '切分评估'] },
    { match: '分块质量', expand: ['chunk', '质量', '切分评估'] },
];

/**
 * 查询展开：命中 SYNONYM_TABLE 的条目时，把对应领域术语去重后追加到 query 尾部。
 *
 * 纯函数，无副作用。匹配基于 trim 后的原 query（不基于逐步拼接的结果），因此扩展词
 * 自身不会再触发新的条目——只跑一遍，无递归膨胀。
 *
 * @param query 原始 query
 * @returns 命中条目时为 `原query 扩展词...`；未命中时原样返回（trim 后）；空输入返回空串
 */
export function expandQuery(query: string): string {
    const base = query.trim();
    if (!base) return '';

    const seen = new Set<string>();
    const terms: string[] = [];
    for (const entry of SYNONYM_TABLE) {
        if (!base.includes(entry.match)) continue;
        for (const term of entry.expand) {
            if (!term || seen.has(term)) continue;
            seen.add(term);
            terms.push(term);
        }
    }

    if (terms.length === 0) return base;
    return `${base} ${terms.join(' ')}`;
}
