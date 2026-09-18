/**
 * 写作模式工具 schema 单元测试
 *
 * 对应设计：.claude/design/tool-calling/tool-calling-detail.md §5 工具协议
 *
 * 验收标准：
 * - 恰好导出三工具，名称与顺序精确匹配 V1 协议
 * - 每个工具的 JSON Schema 收口：required 精确、additionalProperties: false
 * - 描述非空（空描述会让模型乱选工具）
 * - 只断言 schema 形状与值，不依赖运行时 LLM，也不耦合 M-B1 的调用逻辑
 */
import { describe, it, expect } from 'vitest';
import type {
    ChatCompletionFunctionTool,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { chatTools } from '@/services/chat/tools';

/** 收窄 SDK 的宽松 FunctionParameters（Record<string, unknown>），便于断言 JSON Schema 细节 */
type JsonSchema = {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
};

function paramsOf(tool: ChatCompletionFunctionTool): JsonSchema {
    return tool.function.parameters as JsonSchema;
}

function byName(name: string): ChatCompletionFunctionTool {
    const found = chatTools.find((tool) => tool.function.name === name);

    if (!found) throw new Error(`工具 ${name} 未定义`);

    return found;
}

describe('chatTools — 工具集合与命名', () => {
    it('恰好导出三工具，名称与顺序精确匹配 V1 协议', () => {
        expect(chatTools.length).toBe(3);
        expect(chatTools.map((tool) => tool.function.name)).toEqual([
            'update_title',
            'insert_at_cursor',
            'replace_selection',
        ]);
    });

    it('可直接注入 create 的 tools 字段（与 ChatCompletionTool[] 兼容）', () => {
        const injectable: ChatCompletionTool[] = chatTools;

        expect(injectable).toBe(chatTools);
    });

    it.each(chatTools.map((tool) => tool.function.name))(
        '%s：type 为 function、名称合规、描述非空',
        (name) => {
            const { function: fn, type } = byName(name);

            expect(type).toBe('function');
            // OpenAI 命名约束：a-z / 0-9 / 下划线 / 连字符，最长 64
            expect(fn.name).toMatch(/^[a-z][a-z0-9_-]*$/);
            expect(fn.name.length).toBeLessThanOrEqual(64);
            expect((fn.description ?? '').length).toBeGreaterThan(0);
        },
    );
});

describe('chatTools — update_title', () => {
    it('参数为必填的 new_title 字符串', () => {
        const params = paramsOf(byName('update_title'));

        expect(params.type).toBe('object');
        expect(params.properties.new_title?.type).toBe('string');
        expect(params.properties.new_title?.description).toBe(
            '整标题替换后的新标题',
        );
        expect(params.required).toEqual(['new_title']);
    });

    it('描述写明只改标题、不改正文的边界', () => {
        const description = byName('update_title').function.description ?? '';

        expect(description).toContain('标题');
        expect(description).toContain('insert_at_cursor');
        expect(description).toContain('replace_selection');
    });
});

describe('chatTools — markdown 参数类工具（insert_at_cursor / replace_selection）', () => {
    it.each(['insert_at_cursor', 'replace_selection'])(
        '%s：properties 仅含 markdown，required 严格等于 [markdown]',
        (name) => {
            const params = paramsOf(byName(name));

            expect(params.type).toBe('object');
            expect(Object.keys(params.properties)).toEqual(['markdown']);
            expect(params.properties.markdown?.type).toBe('string');
            expect(params.required).toEqual(['markdown']);
        },
    );

    it('insert_at_cursor 的参数描述写明永不静默全文覆盖', () => {
        const params = paramsOf(byName('insert_at_cursor'));

        expect(params.properties.markdown?.description).toBe(
            '在消息发送时快照的光标位置插入的 Markdown 文本；已有正文永不静默全文覆盖',
        );
    });

    it('replace_selection 的参数描述写明无选区时的降级路径', () => {
        const params = paramsOf(byName('replace_selection'));

        expect(params.properties.markdown?.description).toBe(
            '替换消息发送时快照的用户选区的 Markdown 文本；无选区时模型应改走对话澄清或 insert_at_cursor',
        );
    });
});

describe('chatTools — 自审：schema 收口', () => {
    it.each(chatTools.map((tool) => tool.function.name))(
        '%s：additionalProperties 为 false，required 无多余键',
        (name) => {
            const params = paramsOf(byName(name));

            expect(params.additionalProperties).toBe(false);
            // required 必须是 properties 的子集，否则模型永远凑不齐参数
            expect(
                params.required.filter((key) => !(key in params.properties)),
            ).toEqual([]);
        },
    );

    it('三个工具的参数名互不重叠，且未夹带光标/选区上下文（§5.1 走请求体顶层）', () => {
        const allParams = chatTools.flatMap((tool) =>
            Object.keys(paramsOf(tool).properties),
        );

        expect(allParams).toEqual(['new_title', 'markdown', 'markdown']);
        expect(
            allParams.filter((key) => /selection|cursor|docHash/i.test(key)),
        ).toEqual([]);
    });
});
