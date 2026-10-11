// src/services/notebook/noteInjection.service.ts
// 笔记 RAG 注入层：把 searchNotes 的检索结果格式化为 <note_context> XML 块，
// 追加到 system prompt 末尾，完成「双路检索 → 注入」闭环。
// 本层只做消费与注入：负责降级（检索异常不中断对话）与「按全局预算裁剪」。
//
// M4 起裁剪不再用固定 token 预算：逐条累加 countTokens 的办法会在小模型上超、
// 在大模型上浪费，且与 ContextBudgeter 的 L1 逐出/地板语义打架。改为统一委托
// `ContextBudgeter.trimRagChunks`（块内按 score 降序、保留 top ragFloor），
// 预算口径与 chatStream 装配时的账单完全一致。
import { searchNotes } from '@/services/notebook/noteSearch.service';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import { buildNoteContextBlock } from './noteBlock';
import { createLogger } from '@/lib/logger';
import ContextBudgeter from '@/services/chat/tokenBudget.service';
import { BUDGET_CONFIG } from '@/utils/config';

const log = createLogger('rag');

export interface InjectNotesParams {
    userId: string;
    query: string;
    systemPrompt: string;
    notebookId?: string;
    topK?: number;
}

export interface RetrieveNotesParams {
    userId: string;
    query: string;
    notebookId?: string;
    topK?: number;
}

// 复用同一份渲染实现：noteBlock 是纯函数模块，历史调用点仍从本文件 import
export { buildNoteContextBlock } from './noteBlock';

/**
 * 笔记检索（含全部降级），返回按融合分**未排序**的原始召回结果。
 *
 * 降级语义（任一情况都不抛错、不中断对话）：
 * - query 为空 / 纯空白 → 不检索，返回 []
 * - searchNotes 抛错 → 记 warn 日志，返回 []
 *
 * 单列出来的原因：chatStream 的装配需要拿到原始 scoredRag 交给预算器记账
 * （账单要能看见「召回了几条、裁掉了几条」），而只返回字符串的注入函数给不出这批数据。
 */
export async function retrieveNotes(
    params: RetrieveNotesParams,
): Promise<NoteRetrievalResult[]> {
    const { userId, query, notebookId, topK = BUDGET_CONFIG.ragTopK } = params;

    if (!query || !query.trim()) return [];

    try {
        return await searchNotes({ userId, query, notebookId, topK });
    } catch (error) {
        log.warn('笔记检索失败，跳过笔记上下文注入', { error, userId });
        return [];
    }
}

/**
 * 按全局预算裁剪召回结果：委托 ContextBudgeter（块内按 score 降序，保底 top ragFloor）。
 *
 * 固定 1500 token 预算已移除（M4）：预算多寡本是模型规格的函数，写死在注入层
 * 必然小模型超、大模型浪费。改用与 chatStream 同一份「模型输入预算」推导本块天花板
 * = inputBudget × ragMaxRatio，并保留 floor 作逐出下限。
 *
 * 注意 floor 是**逐出下限**而非条数上限：不吃紧时不裁（召回多少注入多少，总量由 topK 兜住），
 * 只有超天花板才从低分端逐出到 floor。chatStream 侧另有 assembleContext 按四块总量裁决，
 * 此处的块占比只是独立入口的近似天花板。
 *
 * 预算器构造失败（模型未登记等配置异常）是配置问题，不该让一次对话崩掉：
 * 记 error 后退化为「按分取 top floor」，与吃紧时的裁剪结果一致。
 */
function trimByGlobalBudget(
    results: NoteRetrievalResult[],
): NoteRetrievalResult[] {
    const floor = BUDGET_CONFIG.ragFloor;
    try {
        const budgeter = new ContextBudgeter();
        const cap = Math.floor(
            budgeter.inputBudget * BUDGET_CONFIG.ragMaxRatio,
        );
        return budgeter.trimRagChunks(results, floor, cap);
    } catch (error) {
        log.error('RAG 预算裁剪不可用，退化为按分取 topN', {
            error,
            floor,
            retrieved: results.length,
        });
        return [...results].sort((a, b) => b.score - a.score).slice(0, floor);
    }
}

/**
 * 把笔记检索结果注入 system prompt，返回最终下发模型的 systemPrompt。
 *
 * 降级语义与检索一致：无召回 / 裁剪后为空 → 原样返回 systemPrompt，绝不抛错。
 */
export async function injectNotesIntoSystemPrompt(
    params: InjectNotesParams,
): Promise<string> {
    const { userId, query, systemPrompt, notebookId, topK } = params;

    const results = await retrieveNotes({ userId, query, notebookId, topK });
    if (results.length === 0) return systemPrompt;

    const retained = trimByGlobalBudget(results);
    if (retained.length === 0) return systemPrompt;

    const block = buildNoteContextBlock(retained);
    log.info('笔记上下文注入成功', {
        retrieved: results.length,
        injected: retained.length,
        floor: BUDGET_CONFIG.ragFloor,
        retained: retained.map((r) => r.content),
        chunkIds: retained.map((r) => r.chunkId),
    });
    return `${systemPrompt}\n\n${block}`;
}
