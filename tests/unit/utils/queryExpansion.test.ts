/**
 * queryExpansion 单元测试
 *
 * 测试目标：expandQuery 的命中追加、多命中去重、无匹配原样返回、空输入、不递归二次展开
 * Mock 依赖：无（纯函数，无 IO —— 同义词表是静态数据，匹配只用 String.includes）
 * 真实逻辑：SYNONYM_TABLE 子串匹配 + 扩展词顺序去重 + 拼接
 */
import { describe, it, expect } from 'vitest';
import { expandQuery, SYNONYM_TABLE } from '@/utils/queryExpansion';

/** 评测数据集里的两条 paraphrase 原句（内联避免单测读文件产生 IO） */
const Q_L2_PARA = '用户很久没说话，系统怎么自动把对话内容存成长期记忆';
const Q_RAG_PARA = '笔记内容是怎么被切分向量化然后送进向量库做语义检索的';

/** 统计子串出现次数（用于断言去重只追加一次） */
function countOccurrences(text: string, sub: string): number {
    return text.split(sub).length - 1;
}

describe('expandQuery', () => {
    it('HP1 - 口语 query「很久没说话 + 存成长期记忆」被扩展出 L2 超时 / 记忆提取术语', () => {
        const result = expandQuery(Q_L2_PARA);

        // 原 query 完整保留（只追加不替换）
        expect(result.startsWith(Q_L2_PARA)).toBe(true);
        // 扩展出的领域术语进入 query 串
        expect(result).toContain('超时触发');
        expect(result).toContain('L2');
        expect(result).toContain('记忆提取');
        expect(result).toContain('静默');
    });

    it('HP2 - 口语 query「切分向量化 + 向量库」被扩展出 分块 / embedding / 语义检索 术语', () => {
        const result = expandQuery(Q_RAG_PARA);

        expect(result.startsWith(Q_RAG_PARA)).toBe(true);
        expect(result).toContain('分块');
        expect(result).toContain('embedding');
        expect(result).toContain('语义检索');
        expect(result).toContain('切片');
    });

    it('边界1 - 空输入（含纯空白）返回空串', () => {
        expect(expandQuery('')).toBe('');
        expect(expandQuery('   ')).toBe('');
    });

    it('边界2 - 无匹配词时原样返回（不被改写、不追加空格）', () => {
        const query = '二分查找的前提条件是什么';
        expect(expandQuery(query)).toBe(query);
    });

    it('边界3 - 多条命中产出重复扩展词时只追加一次（去重生效）', () => {
        // 「存成长期记忆」与「长期记忆」两条命中，expand 完全相同 + L2 重叠
        const result = expandQuery(Q_L2_PARA);

        expect(countOccurrences(result, 'L2')).toBe(1);
        expect(countOccurrences(result, '记忆提取')).toBe(1);
        expect(countOccurrences(result, '自动提取')).toBe(1);
    });

    it('边界4 - 扩展结果不再触发二次展开（无递归膨胀）', () => {
        // 「分块质量」→ 追加「切分评估」，其中含匹配词「切分」；
        // 若在结果上二次展开，会再追加「切片」，此处断言其未发生
        const result = expandQuery('分块质量怎么评测');

        expect(result).toContain('切分评估');
        expect(result).not.toContain('切片');
        expect(countOccurrences(result, '切分评估')).toBe(1);
    });

    it('边界5 - 首尾空白被 trim 后再匹配并返回', () => {
        const result = expandQuery(`  ${Q_L2_PARA}  `);

        expect(result.startsWith(Q_L2_PARA)).toBe(true);
        expect(result).toContain('超时触发');
    });

    it('表结构自审 - 每条 expand 均为非空数组且无重复项', () => {
        expect(SYNONYM_TABLE.length).toBeGreaterThanOrEqual(10);
        for (const entry of SYNONYM_TABLE) {
            expect(entry.match.length).toBeGreaterThan(0);
            expect(entry.expand.length).toBeGreaterThan(0);
            expect(new Set(entry.expand).size).toBe(entry.expand.length);
        }
    });
});
