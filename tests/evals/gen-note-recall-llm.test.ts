// tests/evals/gen-note-recall-llm.test.ts
// 针对 gen-note-recall-llm.ts 的纯函数（stripFence / parseLlmQueries）做单测。
// 这些是"LLM 返回 JSON 鲁棒解析"这一方法论关键路径，不依赖 DB / LLM。
import { describe, it, expect } from 'vitest';
import { stripFence, parseLlmQueries } from '../../scripts/gen-note-recall-llm';

describe('stripFence', () => {
    it('提取 ```json 围栏内的内容', () => {
        const raw = '前缀说明\n```json\n{"a":1}\n```\n后缀';
        expect(stripFence(raw)).toBe('{"a":1}');
    });

    it('无围栏时原样返回并 trim', () => {
        expect(stripFence('  {"a":1}  ')).toBe('{"a":1}');
    });

    it('大小写不敏感且兼容无语言标注围栏', () => {
        expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    });
});

describe('parseLlmQueries', () => {
    it('happy: 解析 {queries:[...]} 并小写化 type', () => {
        const out = parseLlmQueries(
            '{"queries":[{"query":"如何配置 Redis","type":"Exact","sourceId":"abc123"}]}',
        );
        expect(out).toHaveLength(1);
        expect(out[0]!.query).toBe('如何配置 Redis');
        expect(out[0]!.type).toBe('exact');
        expect(out[0]!.sourceId).toBe('abc123');
    });

    it('happy: 兼容顶层数组形式', () => {
        const out = parseLlmQueries(
            '[{"query":"q2","type":"paraphrase","sourceId":"id2"}]',
        );
        expect(out).toHaveLength(1);
        expect(out[0]!.type).toBe('paraphrase');
    });

    it('边界: 去围栏后解析', () => {
        const out = parseLlmQueries(
            '```json\n{"queries":[{"query":"q","type":"negative","sourceId":""}]}\n```',
        );
        expect(out).toHaveLength(1);
        expect(out[0]!.type).toBe('negative');
        expect(out[0]!.sourceId).toBe('');
    });

    it('边界: sourceId 缺失时回退 targetChunkId', () => {
        const out = parseLlmQueries(
            '{"queries":[{"query":"q","type":"exact","targetChunkId":"fallbackId"}]}',
        );
        expect(out[0]!.sourceId).toBe('fallbackId');
    });

    it('边界: 过滤掉无 query 字符串的条目', () => {
        const out = parseLlmQueries(
            '{"queries":[{"type":"exact","sourceId":"x"},{"query":"","type":"exact","sourceId":"y"},{"query":"   ","type":"exact","sourceId":"z"}]}',
        );
        expect(out).toHaveLength(0);
    });

    it('边界: 非法 JSON 抛错（调用方据此重试）', () => {
        expect(() => parseLlmQueries('不是 json {')).toThrow();
    });

    it('边界: 既非数组也无 queries 键抛错', () => {
        expect(() => parseLlmQueries('{"foo":1}')).toThrow();
    });
});
