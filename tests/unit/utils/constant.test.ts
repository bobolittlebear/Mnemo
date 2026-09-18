/**
 * EXTRACTION_PROMPT 文案增补单元测试
 *
 * 本任务只增补 prompt 自然语言文本（类别歧义消解优先级链 + goal/behavior_pattern 对比示例），
 * 因此测试只做「标记存在性」与「既有结构未被破坏」两类断言。
 *
 * 注意：分类准确率的真实提升属 gold-set 度量范畴，不在本文件内验证。
 */
import { describe, it, expect } from 'vitest';
import { EXTRACTION_PROMPT } from '@/utils/constant';

/** 增补前的模板长度（git HEAD 版本实测），用于防误清空 */
const PROMPT_LENGTH_BEFORE = 5550;

describe('EXTRACTION_PROMPT 类别归类增补', () => {
    it('包含类别歧义消解优先级链小节', () => {
        expect(EXTRACTION_PROMPT).toContain('类别歧义消解优先级链');
        expect(EXTRACTION_PROMPT).toContain('goal');
        expect(EXTRACTION_PROMPT).toContain('命中即止');
    });

    it('包含 goal vs behavior_pattern 对比示例', () => {
        expect(EXTRACTION_PROMPT).toContain('goal vs behavior_pattern');
        expect(EXTRACTION_PROMPT).toContain('【示例 5');
        expect(EXTRACTION_PROMPT).toContain('是否含完成标志或时间节点');
    });

    it('优先级链覆盖 event/decision/diet/relationship 优先兜底层', () => {
        expect(EXTRACTION_PROMPT).toContain('event / decision / diet / relationship');
    });

    it('既有章节与示例 1-4 结构未被破坏', () => {
        expect(EXTRACTION_PROMPT).toContain('# 2. 记忆类别');
        expect(EXTRACTION_PROMPT).toContain('# 3. 提取与清洗规则');
        expect(EXTRACTION_PROMPT).toContain('# 6. Few-Shot 示例');
        expect(EXTRACTION_PROMPT).toContain('# 7. 对话内容');
        expect(EXTRACTION_PROMPT).toContain('【示例 1');
        expect(EXTRACTION_PROMPT).toContain('【示例 4');
    });

    it('增补后长度大于修改前，未被误清空', () => {
        expect(typeof EXTRACTION_PROMPT).toBe('string');
        expect(EXTRACTION_PROMPT.length).toBeGreaterThan(PROMPT_LENGTH_BEFORE);
    });

    it('占位符未被破坏', () => {
        expect(EXTRACTION_PROMPT).toContain('{{USER_ID}}');
        expect(EXTRACTION_PROMPT).toContain('{{EXISTING_MEMORIES}}');
        expect(EXTRACTION_PROMPT).toContain('{{CONVERSATION}}');
    });
});
