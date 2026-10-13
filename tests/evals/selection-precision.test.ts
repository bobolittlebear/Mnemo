/**
 * LTM 记忆选择层 —— 无关记忆注入率（precision）评测
 *
 * 与 recall-selection.test.ts（机制/边界回归）不同，本评测度量「选择层四道防线
 * 对无关记忆的过滤效果」这一质量指标：
 *
 *   无关记忆注入率 = 被 select() 选中且不在 relevantIds 里的条数 / 选中条数
 *
 * 数据集 datasets/memory-precision.golden.json 为按 Mnemo 真实用户画像合成的
 * 「对话轮次 + 相关/无关混合候选池」场景，relevantIds 为人工标注的相关性真值。
 *
 * baseline（无闸门对照）= 同候选按 rrfScore 降序取 top-K（K=硬上限）直接注入，
 * 代表「检索返回什么注什么、四道防线全关」。
 *
 * 注意：本评测不为候选注入 mock embedding，故 B 阶段语义去重被跳过（embeddingMissing）。
 * 这意味着门控只跑了 A0 地板 + A1 百分位 + 硬上限三道；真实管线多了去重只会更优，
 * 因此本评测测出的是无关率的【保守下界】，不夸大。
 *
 * 跑完会在 tests/evals/reports/ 生成 selection-precision_<date>.md 报告。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import memorySelectionService from '@/services/memory/memorySelection.service';
import type { MemorySearchResult, EmbeddingProvider } from '@/types/memory';
import { MEMORY_SELECTION_HARD_MAX } from '@/utils/config';
import dataset from './datasets/memory-precision.golden.json';

interface PrecisionEntry {
    id: string;
    description: string;
    context: string;
    candidates: Record<string, unknown>[];
    config?: Record<string, unknown>;
    expected: { relevantIds: string[] };
}

interface PerEntry {
    id: string;
    description: string;
    selected: number;
    irrelevantInjected: number;
    afterRate: number;
    baselineSelected: number;
    baselineIrrelevant: number;
    baselineRate: number;
    irrelevantIds: string[];
}

function asCandidates(raw: Record<string, unknown>[]): MemorySearchResult[] {
    return raw.map((c) => ({
        ...c,
        createdAt: new Date(c.createdAt as string),
        updatedAt: new Date(c.updatedAt as string),
    })) as unknown as MemorySearchResult[];
}

beforeEach(() => {
    // 不提供 embedding → B 阶段去重跳过（embeddingMissing），仅跑 A0/A1/硬上限
    (memorySelectionService as any).embeddingProvider = {
        batchGet: vi.fn().mockResolvedValue(new Map()),
    };
});

describe('LTM 选择层无关记忆注入率评测', () => {
    it('计算 after/baseline 无关率并生成报告', async () => {
        const entries = dataset as unknown as PrecisionEntry[];
        const K = MEMORY_SELECTION_HARD_MAX;
        const perEntry: PerEntry[] = [];

        let sumIrrAfter = 0;
        let sumSelAfter = 0;
        let sumIrrBase = 0;
        let sumSelBase = 0;
        let macroAfterSum = 0;
        let macroBaseSum = 0;

        for (const entry of entries) {
            const candidates = asCandidates(entry.candidates);
            const result = await memorySelectionService.select(
                candidates,
                entry.config as any,
            );
            const selectedIds = result.selected.map((s) => String(s._id));
            const relevant = new Set(entry.expected.relevantIds);

            const irrelevantInjected = selectedIds.filter(
                (id) => !relevant.has(id),
            );
            const afterRate = selectedIds.length
                ? irrelevantInjected.length / selectedIds.length
                : 0;

            // baseline：同候选按 rrfScore 降序取 top-K（无质量闸门）
            const baselineIds = [...candidates]
                .sort((a, b) => b.rrfScore - a.rrfScore)
                .slice(0, K)
                .map((c) => String(c._id));
            const baselineIrrelevant = baselineIds.filter(
                (id) => !relevant.has(id),
            );
            const baselineRate = baselineIds.length
                ? baselineIrrelevant.length / baselineIds.length
                : 0;

            sumIrrAfter += irrelevantInjected.length;
            sumSelAfter += selectedIds.length;
            sumIrrBase += baselineIrrelevant.length;
            sumSelBase += baselineIds.length;
            macroAfterSum += afterRate;
            macroBaseSum += baselineRate;

            perEntry.push({
                id: entry.id,
                description: entry.description,
                selected: selectedIds.length,
                irrelevantInjected: irrelevantInjected.length,
                afterRate,
                baselineSelected: baselineIds.length,
                baselineIrrelevant: baselineIrrelevant.length,
                baselineRate,
                irrelevantIds: irrelevantInjected,
            });
        }

        const n = entries.length;
        const afterMicro = sumSelAfter ? sumIrrAfter / sumSelAfter : 0;
        const baselineMicro = sumSelBase ? sumIrrBase / sumSelBase : 0;
        const afterMacro = macroAfterSum / n;
        const baselineMacro = macroBaseSum / n;
        const absDrop = baselineMicro - afterMicro;
        const relDrop = baselineMicro ? absDrop / baselineMicro : 0;

        // ── 报告 ──
        const date = new Date().toISOString().slice(0, 10);
        const totalCandidates = entries.reduce(
            (s, e) => s + e.candidates.length,
            0,
        );
        const totalRelevant = entries.reduce(
            (s, e) => s + e.expected.relevantIds.length,
            0,
        );

        const lines: string[] = [];
        lines.push('# LTM 选择层无关记忆注入率评测报告');
        lines.push('');
        lines.push(
            '> 本评测度量选择层四道防线（A0 地板 / A1 百分位 / 硬上限；B 去重本评测未启用）对无关记忆的过滤效果。',
        );
        lines.push('');
        lines.push('## 环境与参数');
        lines.push('');
        lines.push(
            `- selection_pipeline: A0 vectorScore 地板 0.5 + A1 rrfScore P70 百分位 + 硬上限 ${K}`,
        );
        lines.push(
            '- B 阶段语义去重: **本评测未启用**（候选无 embedding，embeddingMissing）',
        );
        lines.push(
            '- 含义: 门控仅 A0/A1/硬上限三道；真实管线多出去重只会更优 → 本数字为无关率的**保守下界**',
        );
        lines.push(
            `- embedding_model: text-embedding-v4（生产），本评测以给定 vectorScore 模拟`,
        );
        lines.push(`- generated_at: ${new Date().toISOString()}`);
        lines.push('');
        lines.push('## 数据集');
        lines.push('');
        lines.push(
            `- entries: ${n}（人工标注的「对话轮次 + 混合候选池」场景）`,
        );
        lines.push(
            `- candidates: ${totalCandidates}（相关标注 ${totalRelevant} 条）`,
        );
        lines.push('- 标注方式: 人工标注（relevantIds 为相关性真值）');
        lines.push('');
        lines.push('## 指标定义');
        lines.push('');
        lines.push(
            '- 无关记忆注入率 = 被选中且不在 relevantIds 的条数 / 选中条数',
        );
        lines.push(
            '- micro（池化，主指标）= Σ无关注入 / Σ选中（全局总量占比）',
        );
        lines.push(
            '- macro（逐条平均）= 各 entry 率的算术平均（每条对话等权）',
        );
        lines.push(
            '- baseline = 同候选按 rrfScore 降序取 top-K 直接注入（四道防线全关）',
        );
        lines.push('- 降幅 = baseline_micro − after_micro（绝对）/ 相对');
        lines.push('');
        lines.push('## 各 entry 率');
        lines.push('');
        lines.push(
            '| id | 选中 | 无关注入 | after率 | baseline选中 | baseline无关 | baseline率 | 漏注的无关id |',
        );
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const e of perEntry) {
            lines.push(
                `| ${e.id} | ${e.selected} | ${e.irrelevantInjected} | ${(e.afterRate * 100).toFixed(1)}% | ${e.baselineSelected} | ${e.baselineIrrelevant} | ${(e.baselineRate * 100).toFixed(1)}% | ${e.irrelevantIds.join(',') || '-'} |`,
            );
        }
        lines.push('');
        lines.push('## 汇总');
        lines.push('');
        lines.push('| 指标 | baseline | after | 降幅 |');
        lines.push('|---|---|---|---|');
        lines.push(
            `| micro（主） | ${(baselineMicro * 100).toFixed(1)}% | ${(afterMicro * 100).toFixed(1)}% | 绝对 ${(absDrop * 100).toFixed(1)}pp / 相对 ${(relDrop * 100).toFixed(1)}% |`,
        );
        lines.push(
            `| macro（副） | ${(baselineMacro * 100).toFixed(1)}% | ${(afterMicro === 0 ? 0 : afterMacro * 100).toFixed(1)}% | - |`,
        );
        lines.push('');
        lines.push('## 判定');
        lines.push('');
        lines.push(
            `- 闸门有效性: after_micro ≤ baseline_micro ${afterMicro <= baselineMicro + 1e-9 ? '✅ PASS' : '❌ FAIL'}（门控不应使无关率恶化）`,
        );
        lines.push('');

        const report = lines.join('\n');
        const reportDir = path.resolve(__dirname, 'reports');
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(
            path.join(reportDir, `selection-precision_${date}.md`),
            report,
            'utf-8',
        );

        // ── 断言（不预设具体数字，只验证不变量）──
        // 门控不应使无关率比无闸门更差
        expect(afterMicro).toBeLessThanOrEqual(baselineMicro + 1e-9);
        // 报告已写入
        expect(
            fs.existsSync(
                path.join(reportDir, `selection-precision_${date}.md`),
            ),
        ).toBe(true);

        // 控制台可见，便于本地快速核对
        console.log(
            `\n[selection-precision] after_micro=${(afterMicro * 100).toFixed(1)}% baseline_micro=${(baselineMicro * 100).toFixed(1)}% after_macro=${(afterMacro * 100).toFixed(1)}%\n`,
        );
    });
});
