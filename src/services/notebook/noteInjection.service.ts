// src/services/notebook/noteInjection.service.ts
// 笔记 RAG 注入层：把 searchNotes 的检索结果格式化为 <note_context> XML 块，
// 追加到 system prompt 末尾，完成「双路检索 → 注入」闭环。
// 本层只做消费与注入：负责降级（检索异常不中断对话）与 token 预算控制。
import { searchNotes } from '@/services/notebook/noteSearch.service';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import { countTokens } from '@/utils/tokenizer';
import { createLogger } from '@/lib/logger';

const log = createLogger('rag');

/** 默认检索条数（透传 S5，与 searchNotes 默认值保持一致） */
const DEFAULT_TOP_K = 8;
/** 默认笔记上下文 token 预算 */
const DEFAULT_NOTE_BUDGET_TOKENS = 1500;

export interface InjectNotesParams {
    userId: string;
    query: string;
    systemPrompt: string;
    notebookId?: string;
    topK?: number;
    noteBudgetTokens?: number;
}

/**
 * XML 转义：与记忆注入（chatStream）保持一致，转义 & < > "
 */
function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 单个 note 的注入块：短元数据（noteId / title / section）走属性，长文本走子元素，
 * 与 LTM 的 <mem category=... learned=...>content</mem> 风格保持一致。
 * section 用 `>` 连接 sectionPath；parent_context 为空时省略该元素。
 */
function buildNoteBlock(note: NoteRetrievalResult): string {
    const section = note.sectionPath.join(' > ');
    const lines = [
        `<note note_id="${xmlEscape(note.noteId)}" title="${xmlEscape(note.title)}" section="${xmlEscape(section)}">`,
    ];
    if (note.parentContext) {
        lines.push(
            `<parent_context>${xmlEscape(note.parentContext)}</parent_context>`,
        );
    }
    lines.push(`<content>${xmlEscape(note.content)}</content>`);
    lines.push('</note>');
    return lines.join('\n');
}

/**
 * 组装 <note_context> 注入块（纯函数，便于单测）。
 * 传入结果须已按融合分降序排列；返回 '' 表示无可注入内容。
 */
export function buildNoteContextBlock(results: NoteRetrievalResult[]): string {
    if (results.length === 0) return '';
    const notesXml = results.map((note) => buildNoteBlock(note)).join('\n');
    return `<note_context count="${results.length}">\n${notesXml}\n</note_context>`;
}

/**
 * 把笔记检索结果注入 system prompt，返回最终下发模型的 systemPrompt。
 *
 * 降级语义（任一情况都不抛错、不中断对话）：
 * - query 为空 / 纯空白 → 不检索，原样返回
 * - searchNotes 抛错 → 记 warn 日志，原样返回
 * - 无命中 → 原样返回
 *
 * token 预算：按融合分从高到低累加真实 token 数，超出 noteBudgetTokens 丢弃尾部；
 * 至少保留 score 最高的一条。
 */
export async function injectNotesIntoSystemPrompt(
    params: InjectNotesParams,
): Promise<string> {
    const {
        userId,
        query,
        systemPrompt,
        notebookId,
        topK = DEFAULT_TOP_K,
        noteBudgetTokens = DEFAULT_NOTE_BUDGET_TOKENS,
    } = params;

    // query 为空 / 纯空白：不检索，原样返回
    if (!query || !query.trim()) return systemPrompt;

    // 检索降级：searchNotes 抛错不中断对话，原样返回
    let results: NoteRetrievalResult[];
    try {
        results = await searchNotes({ userId, query, notebookId, topK });
    } catch (error) {
        log.warn('笔记检索失败，跳过笔记上下文注入', { error, userId });
        return systemPrompt;
    }

    // 无命中：不注入
    if (results.length === 0) return systemPrompt;

    // token 预算：按融合分从高到低累加真实 token 数，超预算丢弃尾部
    const sorted = [...results].sort((a, b) => b.score - a.score);
    const retained: NoteRetrievalResult[] = [];
    for (const note of sorted) {
        const block = buildNoteContextBlock([...retained, note]);
        if (countTokens(block) <= noteBudgetTokens) {
            retained.push(note);
        } else if (retained.length === 0) {
            // 至少保留 score 最高的一条（即使单条超预算）
            retained.push(note);
        } else {
            break;
        }
    }

    if (retained.length === 0) return systemPrompt;

    const block = buildNoteContextBlock(retained);
    log.info('笔记上下文注入成功', {
        retrieved: results.length,
        injected: retained.length,
        retained: retained.map((r) => r.content),
        noteBudgetTokens,
    });
    return `${systemPrompt}\n\n${block}`;
}
