/**
 * Mock 工厂 — 集中管理所有外部依赖的 Mock
 *
 * 用法：
 *   在每个 test 文件顶部 vi.mock() 引入对应工厂
 *   在 test 内部通过 vi.mocked() 拿到 Mock 引用做断言
 */
import { vi } from 'vitest';
import * as fixtures from './fixtures';

// ── LLM Mock ──

export const mockCreateChat = vi.fn();

/** 配置 LLM 正常返回 */
export function llmReturnsNormal() {
    mockCreateChat.mockResolvedValue(fixtures.llmNormalResponse);
}

/** 配置 LLM 返回指定内容 */
export function llmReturns(content: { content: string }) {
    mockCreateChat.mockResolvedValue(content);
}

/** 配置 LLM 抛出异常 */
export function llmThrows(error: Error) {
    mockCreateChat.mockRejectedValue(error);
}

/** 配置 LLM 返回 markdown 包裹的 JSON */
export function llmReturnsMarkdownWrapped() {
    mockCreateChat.mockResolvedValue(fixtures.llmMarkdownWrappedResponse);
}

// ── Embedding Mock ──

export const mockGenerateEmbeddings = vi.fn();

export function embeddingReturnsNormal() {
    mockGenerateEmbeddings.mockResolvedValue(fixtures.mockEmbeddings);
}

export function embeddingReturns(count: number) {
    const embeddings = Array.from({ length: count }, (_, i) =>
        Array.from({ length: 5 }, (_, j) => i * 0.1 + j * 0.01),
    );
    mockGenerateEmbeddings.mockResolvedValue({ embeddings });
}

export function embeddingThrows(error: Error) {
    mockGenerateEmbeddings.mockRejectedValue(error);
}

// ── MongoDB Mock ──

export const mockMemoryFactFindOne = vi.fn();
export const mockMemoryFactBulkWrite = vi.fn();
export const mockMemoryFactInsertMany = vi.fn();

/** MemoryFact.findOne 返回 null（未提取过） */
export function factNotFound() {
    mockMemoryFactFindOne.mockResolvedValue(null);
}

/** MemoryFact.findOne 返回已存在记录（已提取过） */
export function factAlreadyExists() {
    mockMemoryFactFindOne.mockResolvedValue({
        _id: 'existing-fact-id',
        memoryKey: fixtures.mockMemoryKey,
        sourceMessageIds: ['msg-001', 'msg-002', 'msg-003'],
    });
}

/** bulkWrite 正常插入 */
export function bulkWriteInserts(count: number) {
    mockMemoryFactBulkWrite.mockResolvedValue({
        insertedCount: count,
        modifiedCount: 0,
        upsertedCount: 0,
        matchedCount: count,
        deletedCount: 0,
    });
}

/** bulkWrite 部分更新 */
export function bulkWriteUpdates(inserted: number, modified: number) {
    mockMemoryFactBulkWrite.mockResolvedValue({
        insertedCount: inserted,
        modifiedCount: modified,
        upsertedCount: 0,
        matchedCount: inserted + modified,
        deletedCount: 0,
    });
}

/** bulkWrite 失败 */
export function bulkWriteThrows(error: Error) {
    mockMemoryFactBulkWrite.mockRejectedValue(error);
}

// ── Redis / STM Mock ──

export const mockSetLastExtractedMsgId = vi.fn();

export function stmSetMarkerSuccess() {
    mockSetLastExtractedMsgId.mockResolvedValue(undefined);
}

export function stmSetMarkerThrows(error: Error) {
    mockSetLastExtractedMsgId.mockRejectedValue(error);
}

// ── 全局重置 ──

export function resetAllMocks() {
    mockCreateChat.mockReset();
    mockGenerateEmbeddings.mockReset();
    mockMemoryFactFindOne.mockReset();
    mockMemoryFactBulkWrite.mockReset();
    mockMemoryFactInsertMany.mockReset();
    mockSetLastExtractedMsgId.mockReset();
}
