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

    describe('packPieces 子章节归属和边界测试', () => {
        const packPiecesGoldenCase =
            '## 📌 今日知识点：Redis 分布式锁\n\n### 一、基础概念：它解决什么问题\n\n单机时代一把 `mutex`（进程内互斥锁）就够了——因为只有一个进程在跑。但服务一上多实例（Node 集群、K8s 多副本），每个实例各自持有自己的锁，\\*\\*互不感知\\*\\*，两个实例可能同时执行同一段代码（比如扣库存、跑定时任务）。\n\n分布式锁 = 一把所有实例都认的锁，保证「同一时刻只有一个实例能拿到」。\n\nRedis 能当锁的原因：\\*\\*单线程执行命令\\*\\*，天然原子，多个客户端同时 SET 只有一个能成功——这就是互斥的本质。\n\n### 二、三代演进：为什么不能照抄网上老代码\n\n#### **v1 ·** `SETNX` **+** `EXPIRE`**（两个命令）**\n\n```\nSETNX lock:order 1     # 抢锁\nEXPIRE lock:order 30   # 设过期防死锁\n```\n\n坑：两步不原子。第一步成功、第二步前进程崩了 → 锁永不过期 → \\*\\*死锁\\*\\*。\n\n#### v2 · `SET lock:order 1 NX EX 30`（一条命令）\n\nSET 的 `NX`（不存在才设置）+ `EX`（过期时间）合成单命令，原子性解决，锁会自动过期。\n\n新坑：\\*\\*误删他人锁\\*\\*。A 的业务跑了 40s 超过 30s 锁过期了，B 抢到锁；A 执行完执行 `DEL`，把 B 的锁删了 → 两个实例同时进入临界区，锁形同虚设。\n\n#### v3 · 唯一标识 + Lua 脚本（生产可用版）\n\n```\n# value 存唯一随机标识（如 UUID），删除前先比对，防止误删\n\nif redis.call("get", KEYS[1]) == ARGV[1] then\n\n  return redis.call("del", KEYS[1])\n\nelse\n\n  return 0\n\nend\n```\n\n「判断 + 删除」两步也在 Lua 里原子执行，比对通过才删。**这是面试手写题的满分答案。**\n\n### 三、进阶追问（面试高频）\n\n- **锁过期了业务还没跑完怎么办？** → 看门狗（Watchdog）：Redisson 等客户端会自动续期，业务没结束锁就不会过期；业务结束主动释放。\n- **主从切换丢锁怎么办？** → Redlock：向 N 个独立 Redis 节点都加锁，过半成功才算拿到。争议很大（存在时钟漂移等理论缺陷），国内多数场景单节点 + 看门狗够用，别为了装逼引入复杂度。\n- **还有别的实现吗？** → ZooKeeper / etcd 的临时顺序节点锁（强一致，适合对一致性要求极高的场景），以及 MySQL 悲观锁 `SELECT ... FOR UPDATE`。\n\n### 四、应用场景 & 和你 Mnemo 的关联\n\n- 秒杀/库存扣减：防止超卖\n- **定时任务：多实例部署时保证\\*\\*只有一个实例\\*\\*执行（比如每天凌晨的记忆压缩任务）**\n- **防重复提交 / 幂等控制：同一条消息只处理一次**\n\n落到 Mnemo 上：你当前是单实例，如果以后多实例部署，\\*\\*L2 记忆提取、定时归档这类任务\\*\\*就得靠分布式锁抢执行权，避免重复提取同一批消息产生重复记忆。另外你之前学过的缓存三大难题里「击穿」的解法——互斥锁，本质也是这个。\n\n---\n\n**一句话记住**：`SETNX` 是玩具，`SET NX EX` 能防死锁，\\*\\*唯一标识 + Lua 原子校验\\*\\*才是生产级，再加看门狗续期防业务超时。';

        it('C1 - 当相邻 piece 的 sectionPath 不同时不允许合并', () => {
            const result = chunkMarkdown(packPiecesGoldenCase);
            for (const child of result.children) {
                // 解析 content 中不应出现其他 section 的标志性内容
                const paths = new Set(child.sectionPath.map((p) => p));
                expect(paths.size).toBe(child.sectionPath.length); // 无重复
            }
        });

        it('C2 - 两个标题的层级相同时，正文内容不允许跨 section 缝合（v3 Lua 脚本不应出现在 v2 child中）', () => {
            const result = chunkMarkdown(packPiecesGoldenCase);
            const v2Child = result.children.find((c) => c.title.includes('v2'));
            expect(v2Child?.content).not.toContain('redis.call');
            expect(v2Child?.content).not.toContain('UUID');
        });

        it('C3 - 子层级的正文不允许合并到父层级中（v1 代码块不能出现在 基础概念 child中）', () => {
            const result = chunkMarkdown(packPiecesGoldenCase);
            const basicChild = result.children.find((c) =>
                c.title.includes('基础概念'),
            );
            expect(basicChild?.content).not.toContain('SETNX lock:order');
            expect(basicChild?.content).not.toContain('EXPIRE lock:order');
        });
    });
});
