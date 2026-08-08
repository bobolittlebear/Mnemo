/**
 * LTM 记忆选择层 Snapshot 评测
 *
 * 读取 datasets/memory-recall.golden.json 中的评测集，
 * 逐条调用 memorySelectionService.select() 并生成 metadata 快照。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import memorySelectionService from '@/services/memory/memorySelection.service';
import type { MemorySearchResult, EmbeddingProvider } from '@/types/memory';
import dataset from './datasets/memory-recall.golden.json';

// ── 类型 ──────────────────────────────────────────────────────

interface EvalEntry {
    id: string;
    description: string;
    candidates: MemorySearchResult[];
    config?: Record<string, unknown>;
    expected: {
        selectedCount: number;
        droppedByDedup?: string[];
        embeddingMissing?: number;
        hardMaxApplied?: boolean;
    };
    _mockEmbeddings?: Record<string, number[]>;
    _mockNullEmbeddings?: string[];
}

// ── 工具 ──────────────────────────────────────────────────────

/**
 * 构造评测所需的 EmbeddingProvider mock。
 * @param embedMap  _id → embedding vector
 * @param nullIds   返回 null 的 _id 列表（模拟 embedding 缺失）
 */
function makeEmbeddingProvider(
    embedMap?: Record<string, number[]>,
    nullIds?: string[],
): EmbeddingProvider {
    return {
        batchGet: vi.fn().mockImplementation(async (ids: string[]) => {
            const result = new Map<string, number[] | null>();
            for (const id of ids) {
                if (nullIds?.includes(id)) {
                    result.set(id, null);
                } else if (embedMap?.[id]) {
                    result.set(id, embedMap[id]);
                }
                // 不在 embedMap 中的 id 不出现在 map 中 → 选择层视为无 embedding
            }
            return result;
        }),
    };
}

/** 将 JSON datasets 中的候选转为 MemorySearchResult（处理 Date 字段） */
function asCandidates(raw: Record<string, unknown>[]): MemorySearchResult[] {
    return raw.map((c) => ({
        ...c,
        createdAt: new Date(c.createdAt as string),
        updatedAt: new Date(c.updatedAt as string),
    })) as unknown as MemorySearchResult[];
}

// ── 注入 mock embeddingProvider ────────────────────────────────

beforeEach(() => {
    // 重置为不提供 embedding 的默认行为 —— 数据驱动测试需自行注入
    (memorySelectionService as any).embeddingProvider = {
        batchGet: vi.fn().mockResolvedValue(new Map()),
    };
});

// ── 数据驱动测试 ───────────────────────────────────────────────

describe.each(dataset as EvalEntry[])('Memory Selection Eval', (entry) => {
    it(`${entry.id}: ${entry.description}`, async () => {
        const candidates = asCandidates(
            entry.candidates as Record<string, unknown>[],
        );

        // 若有 embedding mock 数据，注入 Provider
        if (entry._mockEmbeddings || entry._mockNullEmbeddings) {
            const provider = makeEmbeddingProvider(
                entry._mockEmbeddings,
                entry._mockNullEmbeddings,
            );
            // 通过 Di 入口注入 (构造函数参数)
            (memorySelectionService as any).embeddingProvider = provider;
        }

        const result = await memorySelectionService.select(
            candidates,
            entry.config as any,
        );

        // 精确断言
        expect(
            result.selected.length,
            `selectedCount expected ${entry.expected.selectedCount}, got ${result.selected.length}`,
        ).toBe(entry.expected.selectedCount);

        if (entry.expected.droppedByDedup !== undefined) {
            expect(result.metadata.droppedByDedup).toEqual(
                entry.expected.droppedByDedup,
            );
        }
        if (entry.expected.embeddingMissing !== undefined) {
            expect(result.metadata.embeddingMissing).toBe(
                entry.expected.embeddingMissing,
            );
        }
        if (entry.expected.hardMaxApplied !== undefined) {
            expect(result.metadata.hardMaxApplied).toBe(
                entry.expected.hardMaxApplied,
            );
        }

        // Snapshot 快照（metadata 自动生成到 snapshots/）
        const { selectionLatencyMs, ...snapshotMetadata } = result.metadata;
        expect(selectionLatencyMs).toBeGreaterThanOrEqual(0);
        expect(snapshotMetadata).toMatchSnapshot();
    });
});

// ── Mock 驱动测试：T8b 百分位截断兜底 ─────────────────────────

describe('T8b: 百分位截断返回空集 (mock 强制空集)', () => {
    it('百分位截断返回空数组时，selected 为空', async () => {
        const candidates: MemorySearchResult[] = [
            {
                _id: 'x1',
                content: '用户喜欢红色',
                rrfScore: 0.018,
                vectorScore: 0.55,
                userId: 'u1',
                confidence: 0.9,
                category: 'preference',
                type: 'fact',
                sourceMessageIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                _id: 'x2',
                content: '用户讨厌绿色',
                rrfScore: 0.01,
                vectorScore: 0.48,
                userId: 'u1',
                confidence: 0.9,
                category: 'preference',
                type: 'fact',
                sourceMessageIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];

        // mock: applyPercentileCutoff 返回空数组
        const original = (memorySelectionService as any).applyPercentileCutoff;
        const mockFn = vi
            .fn()
            .mockReturnValue({ results: [], percentileThreshold: 0.99 });
        (memorySelectionService as any).applyPercentileCutoff = mockFn;

        try {
            const result = await memorySelectionService.select(candidates);

            expect(result.selected.length).toBe(0);
            expect(result.metadata).toMatchSnapshot();
        } finally {
            (memorySelectionService as any).applyPercentileCutoff = original;
        }
    });
});

// ── Mock 驱动测试：T15 batchGet 抛异常降级 ────────────────────

describe('T15: batchGet 异常降级 (dedupSkipped=true)', () => {
    it('batchGet 抛 Error 时 B 管跳过 selected=A管输出', async () => {
        const candidates: MemorySearchResult[] = [
            {
                _id: 'y1',
                content: '用户有一只小熊',
                rrfScore: 0.032,
                vectorScore: 0.9,
                userId: 'u1',
                confidence: 0.9,
                category: 'fact',
                type: 'fact',
                sourceMessageIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                _id: 'y2',
                content: '用户每天遛小熊',
                rrfScore: 0.031,
                vectorScore: 0.82,
                userId: 'u1',
                confidence: 0.8,
                category: 'behavior_pattern',
                type: 'fact',
                sourceMessageIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                _id: 'y3',
                content: '用户吃素',
                rrfScore: 0.02,
                vectorScore: 0.15,
                userId: 'u1',
                confidence: 0.9,
                category: 'diet',
                type: 'fact',
                sourceMessageIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];

        const crashProvider: EmbeddingProvider = {
            batchGet: vi.fn().mockRejectedValue(new Error('Mongo timeout')),
        };
        (memorySelectionService as any).embeddingProvider = crashProvider;

        const result = await memorySelectionService.select(candidates, {
            percentile: 0.4,
        });

        // P40 保留 y1+y2，B 管抛异常 → dedupSkipped=true，selected=2
        expect(result.selected.length).toBe(2);
        expect(result.metadata.dedupSkipped).toBe(true);
        expect(result.metadata).toMatchSnapshot();
    });
});
