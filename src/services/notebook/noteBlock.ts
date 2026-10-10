// src/services/notebook/noteBlock.ts
// 笔记注入块的纯渲染层：<note_context> XML 的拼装。
//
// 单独成模块的原因：M4 之后有两处需要渲染同一个块——
//   1. noteInjection.service（检索 → 裁剪 → 拼接，独立入口）
//   2. chat/tokenBudget.service 的 buildSystemPrompt（把裁剪后的 RAG 拼进 system prompt）
// 若把渲染留在 noteInjection，则 budgeter → noteInjection（要渲染函数）与
// noteInjection → budgeter（要 trimRagChunks）互相 import，形成循环依赖。
// 本模块零依赖（不 import 任何 service），作为叶子节点解开该环。
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';

/**
 * XML 转义：与记忆注入的 <mem> 块保持同一套规则，转义 & < > "
 */
export function xmlEscape(value: string): string {
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
export function buildNoteBlock(note: NoteRetrievalResult): string {
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
