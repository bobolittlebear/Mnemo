/**
 * noteChunker 单元测试
 *
 * 测试目标：父子切分、结构单元保护、token-aware 边界、统计信息
 * 依赖：真实 countTokens（tiktoken），不 mock —— token 边界断言才有意义
 * 不测：remark 库自身解析正确性（库职责）、空输入行为（实现决定，不强行断言）
 */
import { describe, it, expect } from 'vitest';
import { chunkMarkdown, DEFAULT_CHUNK_CONFIG } from '@/utils/noteChunker';
import { countTokens } from '@/utils/tokenizer';
import { generateContentHash } from '@/utils/tool';

// ── 辅助：把 base 重复到目标 token 数（用于构造确定尺寸的段落）──
function repeatToTokens(text: string, targetTokens: number): string {
    let result = '';
    while (countTokens(result) < targetTokens) {
        result += text;
    }
    return result;
}

// ── 辅助：构造指定 token 数的代码块（保持 ≤ maxChildTokens 且 > minChildTokens）──
function codeBlockOf(targetTokens: number): string {
    const lines = [
        'function add(a, b) {',
        '  const sum = a + b;',
        '  return sum;',
        '}',
    ];
    const out: string[] = [];
    while (countTokens(out.join('\n')) < targetTokens) {
        out.push(...lines);
    }
    return '```javascript\n' + out.join('\n') + '\n```';
}

// ── 辅助：构造指定 token 数的表格（保持 ≤ maxChildTokens 且 > minChildTokens）──
function tableBlockOf(targetTokens: number): string {
    const rows = ['| 名称 | 路径 |', '|------|------|'];
    while (countTokens(rows.join('\n')) < targetTokens) {
        rows.push(`| 项${rows.length} | /usr/local/${rows.length} |`);
    }
    return rows.join('\n');
}

describe('noteChunker', () => {
    // ── Happy path ──
    it('H1 - 两个 ## 章节各自独立成 parent，child 指向正确 parent', () => {
        const md =
            `## 安装说明\n\n` +
            repeatToTokens('安装的详细步骤说明，请按照以下顺序操作。', 80) +
            `\n\n## 使用说明\n\n` +
            repeatToTokens('使用的详细说明，涵盖常用命令与注意事项。', 80);

        const result = chunkMarkdown(md);

        // parent 数量与 sectionPath
        expect(result.parents).toHaveLength(2);
        expect(result.parents[0]!.sectionPath).toEqual(['安装说明']);
        expect(result.parents[1]!.sectionPath).toEqual(['使用说明']);
        expect(result.parents[0]!.title).toBe('安装说明');
        expect(result.parents[1]!.title).toBe('使用说明');
        expect(result.parents.map((p) => p.chunkIndex)).toEqual([0, 1]);

        // child 指向正确 parent + 全局顺序
        expect(result.children).toHaveLength(2);
        expect(result.children[0]!.parentIndex).toBe(0);
        expect(result.children[1]!.parentIndex).toBe(1);
        expect(result.children[0]!.sectionPath).toEqual(['安装说明']);
        expect(result.children.map((c) => c.chunkIndex)).toEqual([0, 1]);

        // contentHash 与独立计算一致
        for (const p of result.parents) {
            expect(p.contentHash).toBe(generateContentHash(p.content));
        }
        for (const c of result.children) {
            expect(c.contentHash).toBe(generateContentHash(c.content));
        }

        // stats 数值正确
        const tokenCounts = result.children.map((c) => countTokens(c.content));
        expect(result.stats.parentCount).toBe(2);
        expect(result.stats.childCount).toBe(2);
        expect(result.stats.avgChildTokens).toBe(
            Math.round(
                tokenCounts.reduce((sum, n) => sum + n, 0) / tokenCounts.length,
            ),
        );
        expect(result.stats.maxChildTokens).toBe(Math.max(...tokenCounts));
        expect(result.stats.minChildTokens).toBe(Math.min(...tokenCounts));
        expect(result.stats.forcedSplitCount).toBe(0);

        // child 零重叠
        expect(result.children[1]!.content).not.toContain(
            result.children[0]!.content,
        );
    });

    it('H2 - 代码块与表格各自整体作为一个 child，不被切断', () => {
        const md =
            `## 代码与表格\n\n` + codeBlockOf(200) + `\n\n` + tableBlockOf(200);

        const result = chunkMarkdown(md);

        expect(result.parents).toHaveLength(1);
        expect(result.parents[0]!.sectionPath).toEqual(['代码与表格']);

        // 代码块、表格各超 min 且相加超 max → 两个独立 child
        expect(result.children).toHaveLength(2);
        expect(result.stats.forcedSplitCount).toBe(0);
        expect(result.children.map((c) => c.chunkIndex)).toEqual([0, 1]);

        // child[0] 是完整代码块（围栏 + 函数体都在，未被切断）
        expect(result.children[0]!.content).toContain('```javascript');
        expect(result.children[0]!.content).toContain('function add');
        expect(result.children[0]!.content).toContain('return sum;');
        // child[1] 是完整表格（表头 + 分隔行 + 数据行都在）
        expect(result.children[1]!.content).toContain('| 名称 |');
        expect(result.children[1]!.content).toContain('| --- | --- |');
        expect(result.children[1]!.content).toContain('/usr/local/');
        // 代码块与表格没有被混入对方
        expect(result.children[0]!.content).not.toContain('| 名称 |');
        expect(result.children[1]!.content).not.toContain('```javascript');
    });

    // ── 边界覆盖 ──
    it('B1 - 无标题文档按 token 阈值切分，sectionPath 为空数组', () => {
        const longText = repeatToTokens(
            '这是无标题文档中的正文内容，用于验证纯文本按 token 阈值切分。',
            2000,
        );

        const result = chunkMarkdown(longText);

        expect(result.parents.length).toBeGreaterThanOrEqual(2);
        expect(result.parents.every((p) => p.sectionPath.length === 0)).toBe(
            true,
        );
        // 每个 parent 不超过 maxParentTokens
        expect(
            result.parents.every(
                (p) =>
                    countTokens(p.content) <=
                    DEFAULT_CHUNK_CONFIG.maxParentTokens,
            ),
        ).toBe(true);
        // 正文不丢：child 内容合并（去空白）还原源文
        const joined = result.children
            .map((c) => c.content)
            .join('')
            .replace(/\s/g, '');
        expect(joined).toBe(longText.replace(/\s/g, ''));
    });

    it('B2 - 代码块内的假标题/空行不被误判为标题或段落边界', () => {
        const md =
            '## 代码示例\n\n' +
            '```javascript\n' +
            '# 这是注释\n' +
            '## 假标题\n' +
            '\n' +
            'function add(a, b) {\n' +
            '    return a + b;\n' +
            '}\n' +
            '```\n';

        const result = chunkMarkdown(md);

        // 假标题不会产生额外 parent
        expect(result.parents).toHaveLength(1);
        expect(result.parents[0]!.sectionPath).toEqual(['代码示例']);
        expect(
            result.parents.every((p) => !p.sectionPath.includes('假标题')),
        ).toBe(true);

        // 代码块整体为一个 child，假标题作为字面文本保留
        expect(result.children).toHaveLength(1);
        expect(result.children[0]!.content).toContain('# 这是注释');
        expect(result.children[0]!.content).toContain('## 假标题');
        expect(result.children[0]!.content).toContain('function add');
    });

    it('B3 - 多行表格整体为一个 child，不被 \\n\\n 切散，管道转义不破坏结构', () => {
        const md =
            '## 表格\n\n' +
            '| 名称 | 路径 |\n' +
            '|------|------|\n' +
            '| 转义管道 | A \\| B |\n' +
            '| 正常路径 | /usr/local/bin |\n';

        const result = chunkMarkdown(md);

        expect(result.parents).toHaveLength(1);
        expect(result.children).toHaveLength(1);
        const table = result.children[0]!.content;
        expect(table).toContain('| 名称 |');
        expect(table).toContain('转义管道');
        expect(table).toContain('/usr/local/bin');
        // 表头与数据行同属一个 child（未被 \n\n 切散）
        expect(table).toContain('正常路径');
    });

    it('B4 - 嵌套标题 sectionPath 逐级正确', () => {
        const aOwn = repeatToTokens('A 章节自身的介绍内容。', 400);
        const a1Own = repeatToTokens('A.1 小节的详细说明内容。', 800);
        const a11Own = repeatToTokens('A.1.1 小节的具体实现细节。', 800);
        const md = `## A\n\n${aOwn}\n\n### A.1\n\n${a1Own}\n\n#### A.1.1\n\n${a11Own}`;

        const result = chunkMarkdown(md);

        // A 自身 + A.1 自身 + A.1.1 整体，各成一个 parent
        expect(result.parents.map((p) => p.sectionPath)).toEqual([
            ['A'],
            ['A', 'A.1'],
            ['A', 'A.1', 'A.1.1'],
        ]);
        expect(result.parents.map((p) => p.title)).toEqual([
            'A',
            'A.1',
            'A.1.1',
        ]);
        // 每个 parent 自带所属标题
        expect(result.parents[0]!.content).toContain('## A');
        expect(result.parents[1]!.content).toContain('### A.1');
        expect(result.parents[2]!.content).toContain('#### A.1.1');
    });

    it('B5 - 超长单段按句子边界切分，forcedSplitCount 增加', () => {
        const longPara = repeatToTokens(
            '这是第 N 个测试句子，用于验证超长段落会被按句子边界切分成多个 child。',
            800,
        );

        const result = chunkMarkdown(longPara);

        expect(result.parents).toHaveLength(1);
        expect(result.children.length).toBeGreaterThanOrEqual(2);
        expect(result.stats.forcedSplitCount).toBe(1);
        // 切分点落在句子边界：每个 child 以句子结束标点收尾
        expect(
            result.children.every((c) =>
                /[。！？!?；;]$/.test(c.content.trim()),
            ),
        ).toBe(true);
        // 零重叠 + 零丢失：合并 child 内容（去空白）还原源文
        const joined = result.children
            .map((c) => c.content)
            .join('')
            .replace(/\s/g, '');
        expect(joined).toBe(longPara.replace(/\s/g, ''));
    });

    it('B6 - 多个超短段合并到相邻 chunk，而非独立成 chunk 或跳过', () => {
        const md = [
            '短段落一，内容很少。',
            '短段落二，内容很少。',
            '短段落三，内容很少。',
            '短段落四，内容很少。',
        ].join('\n\n');

        const result = chunkMarkdown(md);

        // 全部短段合成一个 chunk，而不是 4 个独立 chunk
        expect(result.children).toHaveLength(1);
        const content = result.children[0]!.content;
        expect(content).toContain('短段落一');
        expect(content).toContain('短段落二');
        expect(content).toContain('短段落三');
        expect(content).toContain('短段落四');
        expect(countTokens(content)).toBeLessThanOrEqual(
            DEFAULT_CHUNK_CONFIG.maxChildTokens,
        );
    });

    it('B7 - 中英文混排 token 精确计数，切分不产生乱码', () => {
        const md =
            '## 混合内容\n\n' +
            'English sentence with 中文词语 and numbers 123.\n\n' +
            '更多中文内容，包含标点符号！ Plus English tail.';

        const result = chunkMarkdown(md);

        expect(result.parents).toHaveLength(1);
        expect(result.parents[0]!.sectionPath).toEqual(['混合内容']);
        expect(result.children).toHaveLength(1);
        const content = result.children[0]!.content;
        expect(content).toContain('English sentence');
        expect(content).toContain('中文词语');
        expect(content).toContain('更多中文内容');
        expect(content).not.toContain('�'); // 无替换符/乱码
        expect(countTokens(content)).toBeGreaterThan(0);
        // contentHash 与独立计算一致
        expect(result.children[0]!.contentHash).toBe(
            generateContentHash(content),
        );
    });
});
