// src/utils/noteChunker.ts
// Markdown 切片器（父子块）：parent 自适应层级切分（不向量化），child 结构单元 + token-aware 切分（向量化）。
// 纯函数，不涉及 DB、不涉及 embedding。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { RootContent, ListItem, Root, Table, TableCell } from 'mdast';
import { countTokens, getEncoder } from '@/utils/tokenizer';
import { generateContentHash } from '@/utils/tool';
import {
    ChildChunk,
    ChunkConfig,
    ChunkResult,
    ChunkStats,
    ParentChunk,
} from '@/types/noteChunk';

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
    maxParentTokens: 1500,
    maxChildTokens: 300,
    minChildTokens: 50,
};

type BlockType = 'code' | 'list' | 'table' | 'quote' | 'paragraph';

/** 结构单元：代码块 > 列表 > 表格 > 引用块 > 段落 */
interface Block {
    type: BlockType;
    text: string;
    segments: string[]; // 用于超长切分的自然边界（行 / 列表项 / 表格行 / 句子）
    tokens: number;
}

interface BlockRef {
    block: Block;
    sectionPath: string[]; // 该块所属章节路径（用于 child 归位）
}

interface Piece {
    refs: BlockRef[];
    text: string;
    tokens: number;
}

interface Section {
    depth: number;
    title: string;
    sectionPath: string[];
    blocks: Block[];
    children: Section[];
    totalTokens: number;
}

interface ParentBundle {
    parent: Omit<ParentChunk, 'chunkIndex'>;
    refs: BlockRef[]; // 该 parent 覆盖的全部块（供 child 切分）
}

const HEADING_MARKS = ['', '#', '##', '###', '####', '#####', '######'];
const SEPARATOR = '\n\n';

// 句子边界（保留结束标点）
const SENTENCE_RE = /(?<=[。！？!?；;])\s*/;
// 超长单元切分的递进边界：句子 → 分句 → 空白
const SPLIT_BOUNDARIES: RegExp[] = [
    SENTENCE_RE,
    /(?<=[，,、：:])/,
    /(?<=[ \t])/,
];

/* ------------------------------------------------------------------ */
/* Markdown → mdast → 块文本                                            */
/* ------------------------------------------------------------------ */

function inlineChildren(node: { children: unknown }): string {
    return (node.children as RootContent[]).map(serializeInline).join('');
}

/** 内联节点 → 文本（保留基础 markdown 语法） */
function serializeInline(node: RootContent): string {
    switch (node.type) {
        case 'text':
            return node.value ?? '';
        case 'inlineCode':
            return `\`${node.value}\``;
        case 'emphasis':
            return `*${inlineChildren(node)}*`;
        case 'strong':
            return `**${inlineChildren(node)}**`;
        case 'delete':
            return `~~${inlineChildren(node)}~~`;
        case 'link':
            return `[${inlineChildren(node)}](${node.url})`;
        case 'image':
            return `![${node.alt ?? ''}](${node.url})`;
        case 'break':
            return '\n';
        case 'html':
            return node.value ?? '';
        case 'linkReference':
            return `[${node.label ?? ''}]`;
        case 'imageReference':
            return `![${node.alt ?? ''}]`;
        case 'footnoteReference':
            return `[^${node.identifier}]`;
        default:
            if ('children' in node)
                return (node as { children: RootContent[] }).children
                    .map(serializeInline)
                    .join('');
            if ('value' in node)
                return String((node as { value: unknown }).value ?? '');
            return '';
    }
}

function headingText(depth: number, title: string): string {
    const marks = HEADING_MARKS[depth] ?? '#';
    return title ? `${marks} ${title}` : marks;
}

/** 任意节点 → 块级文本（嵌套场景复用） */
function serializeNode(node: RootContent): string {
    switch (node.type) {
        case 'heading':
            return headingText(node.depth, serializeInline(node).trim());
        case 'paragraph':
            return serializeInline(node);
        case 'code':
            return `\`\`\`${node.lang ?? ''}\n${node.value}\n\`\`\``;
        case 'list':
            return node.children
                .map((item, i) =>
                    serializeListItem(item, i, node.ordered, node.start),
                )
                .join('\n');
        case 'table':
            return serializeTable(node);
        case 'blockquote': {
            const inner = (node.children as RootContent[])
                .map(serializeNode)
                .filter(Boolean)
                .join('\n\n');
            return inner
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n');
        }
        case 'thematicBreak':
            return '---';
        case 'html':
            return node.value ?? '';
        case 'definition':
            return `[${node.identifier}]: ${node.url}`;
        default:
            return serializeInline(node);
    }
}

function alignMarker(align: string | null | undefined): string {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
}

function serializeTableCell(cell: TableCell): string {
    return cell.children.map(serializeInline).join('');
}

/** 表格 → 行数组（首行 = 表头 + 分隔行） */
function serializeTableRows(node: Table): string[] {
    const [headerRow, ...dataRows] = node.children;
    const headerCells = (headerRow?.children ?? []).map(serializeTableCell);
    const aligns = node.align ?? [];
    const header = `| ${headerCells.join(' | ')} |`;
    const delim = `| ${headerCells.map((_, i) => alignMarker(aligns[i])).join(' | ')} |`;
    const rows = dataRows.map(
        (row) => `| ${row.children.map(serializeTableCell).join(' | ')} |`,
    );
    return [header, delim, ...rows];
}

function serializeTable(node: Table): string {
    return serializeTableRows(node).join('\n');
}

function serializeListItem(
    item: ListItem,
    index: number,
    ordered: boolean | null | undefined,
    start: number | null | undefined,
): string {
    const marker = ordered ? `${(start ?? 1) + index}. ` : '- ';
    const task =
        item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
    const prefix = `${marker}${task}`;
    const indent = ' '.repeat(prefix.length);
    const body = (item.children as RootContent[])
        .map(serializeNode)
        .filter(Boolean)
        .join('\n');
    return body
        .split('\n')
        .map((line, i) => (i === 0 ? `${prefix}${line}` : `${indent}${line}`))
        .join('\n');
}

function splitSentences(text: string): string[] {
    return text.split(SENTENCE_RE).filter(Boolean);
}

/** 顶级内容节点 → 结构单元 Block；标题 / 水平线由章节树消费 */
function toBlock(node: RootContent): Block | null {
    switch (node.type) {
        case 'code': {
            const text = `\`\`\`${node.lang ?? ''}\n${node.value}\n\`\`\``;
            return {
                type: 'code',
                text,
                segments: node.value.split('\n'),
                tokens: countTokens(text),
            };
        }
        case 'list': {
            const items = node.children.map((item, i) =>
                serializeListItem(item, i, node.ordered, node.start),
            );
            const text = items.join('\n');
            return {
                type: 'list',
                text,
                segments: items,
                tokens: countTokens(text),
            };
        }
        case 'table': {
            const rows = serializeTableRows(node);
            const text = rows.join('\n');
            return {
                type: 'table',
                text,
                segments: rows,
                tokens: countTokens(text),
            };
        }
        case 'blockquote': {
            const inner = (node.children as RootContent[])
                .map(serializeNode)
                .filter(Boolean)
                .join('\n\n');
            const text = inner
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n');
            return {
                type: 'quote',
                text,
                segments: splitSentences(text),
                tokens: countTokens(text),
            };
        }
        case 'heading':
        case 'thematicBreak':
            return null;
        default: {
            const text = serializeNode(node);
            if (!text.trim()) return null;
            return {
                type: 'paragraph',
                text,
                segments: splitSentences(text),
                tokens: countTokens(text),
            };
        }
    }
}

/* ------------------------------------------------------------------ */
/* 标题树构建                                                           */
/* ------------------------------------------------------------------ */

function topSection(stack: Section[]): Section | undefined {
    return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

function buildSections(root: Root): Section[] {
    // depth 0 的伪根：收纳首个标题之前的正文 + 所有顶层标题章节
    const pre: Section = {
        depth: 0,
        title: '',
        sectionPath: [],
        blocks: [],
        children: [],
        totalTokens: 0,
    };
    const stack: Section[] = [];
    const roots: Section[] = [pre];

    for (const node of root.children) {
        if (node.type === 'heading') {
            let top = topSection(stack);
            while (top && top.depth >= node.depth) {
                stack.pop();
                top = topSection(stack);
            }
            const parent = top ?? pre;
            const title = serializeInline(node)
                .trim()
                .replace(/\*\*(.+?)\*\*/g, '$1') // UI层优化: 去加粗
                .replace(/`(.+?)`/g, '$1'); // UI层优化: 去行内代码
            const section: Section = {
                depth: node.depth,
                title,
                sectionPath: [...parent.sectionPath, title].filter(Boolean),
                blocks: [],
                children: [],
                totalTokens: 0,
            };
            parent.children.push(section);
            stack.push(section);
        } else {
            const target = topSection(stack) ?? pre;
            const block = toBlock(node);
            if (block) target.blocks.push(block);
        }
    }

    computeTokens(pre);
    return roots;
}

function computeTokens(section: Section): number {
    let total = section.title
        ? countTokens(headingText(section.depth, section.title))
        : 0;
    for (const block of section.blocks) total += block.tokens;
    for (const child of section.children) total += computeTokens(child);
    section.totalTokens = total;
    return total;
}

function serializeSection(section: Section): string {
    const parts: string[] = [];
    if (section.title) parts.push(headingText(section.depth, section.title));
    parts.push(...section.blocks.map((block) => block.text));
    for (const child of section.children) parts.push(serializeSection(child));
    return parts.filter(Boolean).join('\n\n');
}

/** 扁平化章节 → 文档序的块引用（含各自所属 sectionPath） */
function flattenSection(section: Section): BlockRef[] {
    const refs: BlockRef[] = section.blocks.map((block) => ({
        block,
        sectionPath: section.sectionPath,
    }));
    for (const child of section.children) refs.push(...flattenSection(child));
    return refs;
}

/* ------------------------------------------------------------------ */
/* token-aware 切分与合并                                               */
/* ------------------------------------------------------------------ */

/** 超长结构单元：按块内自然边界（行/列表项/表格行/句子）token-aware 切分 */
function splitBlockBySegments(block: Block, maxTokens: number): string[] {
    const joinSep =
        block.type === 'paragraph' || block.type === 'quote' ? '' : '\n';
    const sepTokens = countTokens(joinSep);
    const out: string[] = [];
    let current = '';
    let currentTokens = 0;

    for (const seg of block.segments) {
        const segTokens = countTokens(seg);
        if (segTokens > maxTokens) {
            if (current) {
                out.push(current);
                current = '';
                currentTokens = 0;
            }
            out.push(...splitByMaxTokens(seg, maxTokens));
            continue;
        }
        if (current && currentTokens + sepTokens + segTokens > maxTokens) {
            out.push(current);
            current = seg;
            currentTokens = segTokens;
        } else {
            current += (current ? joinSep : '') + seg;
            currentTokens += current ? sepTokens + segTokens : segTokens;
        }
    }
    if (current) out.push(current);
    return out;
}

/** 单段超长 → 递进边界（句子 → 分句 → 空白 → 兜底字符）保证有解 */
function splitByMaxTokens(text: string, maxTokens: number): string[] {
    if (countTokens(text) <= maxTokens) return [text];
    for (const re of SPLIT_BOUNDARIES) {
        const parts = text.split(re).filter(Boolean);
        if (
            parts.length > 1 &&
            parts.every((part) => countTokens(part) <= maxTokens)
        ) {
            return parts;
        }
    }
    return hardSplitByTokens(text, maxTokens);
}

/**
 * 块大小超过 maxTokens 时的最后兜底切断。
 *
 * 性能：整段只 encode 1 次（消除逐字符 countTokens 的 O(n) WASM 调用），
 * 字节跨度用块级 decode 拿长度（O(块数) 次，绝非逐 token O(N) WASM 调用 + N 次数组分配）。
 *
 * 正确性（关键）：tiktoken 的 token 边界会落在多字节字符中间（实测连常见中文都会被
 * 切断并产生 U+FFFD），因此绝不能直接把 decode 出的字节当文本。这里改用
 * 「token 计数定切点 + 原文字节数组 subarray + 吸附到完整字符边界」：
 * 1. 块级 decode(tokens.slice) 仅用于拿该段精确字节跨度（纯字节拼接，不产生 FFFD）；
 * 2. 在字节切点上向前吸附跳过 UTF-8 续字节（0x80..0xBF），绝不切断多字节字符；
 * 3. 用原文字节数组 bytes.subarray(start, end) 取子串，输出严格等于原文、无乱码。
 * 吸附起点有 byteStart 下界保护，物理上不可能越过 chunk 起点。
 */
function hardSplitByTokens(text: string, maxTokens: number): string[] {
    const enc = getEncoder();
    const tokenIds = enc.encode(text); // 仅 1 次 WASM 调用
    if (tokenIds.length <= maxTokens) return [text];

    const bytes = new TextEncoder().encode(text); // 原文字节数组（UTF-8）
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const pieces: string[] = [];

    let byteStart = 0;
    for (let k = maxTokens; k < tokenIds.length; k += maxTokens) {
        // 块级 decode 仅用于拿字节跨度（O(块数) 次，非 O(N)），不用于生成文本
        const blockBytes = enc.decode(tokenIds.subarray(k - maxTokens, k));
        let byteEnd = byteStart + blockBytes.length; // 该 token 段的精确字节跨度
        // 向前吸附到完整字符边界：跳过 UTF-8 续字节，绝不切断多字节字符
        while (
            byteEnd > byteStart &&
            byteEnd < bytes.length &&
            (bytes[byteEnd]! & 0xc0) === 0x80
        )
            byteEnd--;
        pieces.push(decoder.decode(bytes.subarray(byteStart, byteEnd)));
        byteStart = byteEnd;
    }
    // 尾块：剩余字节（已被吸附到字符边界，或本就到末尾）
    // 防御：byteStart 可能因吸附推到末尾导致尾块为空串，跳过避免无意义空 chunk
    const tail = decoder.decode(bytes.subarray(byteStart));
    if (tail) pieces.push(tail);
    return pieces;
}
/** 把 ref 的块文本切片为子块：上层按更细粒度切分时只作用于该子内容，避免跨 parent 重复 */
function sliceBlockRef(ref: BlockRef, text: string): BlockRef {
    const segments =
        ref.block.type === 'paragraph' || ref.block.type === 'quote'
            ? splitSentences(text)
            : text.split('\n').filter(Boolean);
    return {
        ...ref,
        block: { ...ref.block, text, tokens: countTokens(text), segments },
    };
}

/** 块引用 → 候选块（超长块在此强制切分，切出的子块携带切片 ref） */
function piecesFromRefs(refs: BlockRef[], maxTokens: number): Piece[] {
    const pieces: Piece[] = [];
    for (const ref of refs) {
        if (ref.block.tokens <= maxTokens) {
            pieces.push({
                refs: [ref],
                text: ref.block.text,
                tokens: ref.block.tokens,
            });
        } else {
            for (const sub of splitBlockBySegments(ref.block, maxTokens)) {
                const sliced = sliceBlockRef(ref, sub);
                pieces.push({
                    refs: [sliced],
                    text: sub,
                    tokens: sliced.block.tokens,
                });
            }
        }
    }
    return pieces;
}

/** 判断两组 refs 是否属于同一个 section */
function isSameSection(a: BlockRef[], b: BlockRef[]): boolean {
    const pathA = a[0]?.sectionPath;
    const pathB = b[0]?.sectionPath;
    if (!pathA || !pathB) return false;
    if (pathA.length !== pathB.length) return false;
    for (let i = 0; i < pathA.length; i++) {
        if (pathA[i] !== pathB[i]) return false;
    }
    return true;
}

/** 候选块打包：不超过 maxTokens，末尾不足 minTokens 的块合并到相邻块（不丢弃） */
function packPieces(
    pieces: Piece[],
    maxTokens: number,
    minTokens: number,
): Piece[] {
    const chunks: Piece[] = [];
    const sepTokens = countTokens(SEPARATOR);
    let current: Piece | null = null;

    for (const piece of pieces) {
        if (!current) {
            current = {
                refs: [...piece.refs],
                text: piece.text,
                tokens: piece.tokens,
            };
            continue;
        }

        // 检查 section 边界
        const sameSection = isSameSection(current.refs, piece.refs);
        const fits = current.tokens + sepTokens + piece.tokens <= maxTokens;

        if (sameSection && fits) {
            current.refs.push(...piece.refs);
            current.text += SEPARATOR + piece.text;
            current.tokens += sepTokens + piece.tokens;
        } else {
            chunks.push(current);
            current = {
                refs: [...piece.refs],
                text: piece.text,
                tokens: piece.tokens,
            };
        }
    }
    if (current) chunks.push(current);

    if (minTokens > 0) return mergeShortChunks(chunks, minTokens);
    return chunks;
}

/** 合并 token 小于 minToken 的块
 * 1. 若同 section，并入前一块
 * 2. 若同 section，并入后一块
 * 3. 前后都不同 section → 保留为独立 chunk，不强制合并
 */
function mergeShortChunks(
    chunks: Piece[],
    minTokens: number,
    respectSectionBoundary = true,
): Piece[] {
    const result: Piece[] = [];
    const sepTokens = countTokens(SEPARATOR);
    let i = 0;
    while (i < chunks.length) {
        const c = chunks[i]!;
        if (c.tokens < minTokens) {
            // 优先并入前一块（需同 section）
            if (result.length > 0) {
                const prev = result[result.length - 1]!;
                const canMergePrev =
                    !respectSectionBoundary || isSameSection(prev.refs, c.refs);

                if (canMergePrev) {
                    prev.refs.push(...c.refs);
                    prev.text += SEPARATOR + c.text;
                    prev.tokens += sepTokens + c.tokens;
                    i++;
                    continue;
                }
            }
            if (i + 1 < chunks.length) {
                const next = chunks[i + 1]!;
                const canMergeNext =
                    !respectSectionBoundary || isSameSection(c.refs, next.refs);
                if (canMergeNext) {
                    next.refs = [...c.refs, ...next.refs];
                    next.text = c.text + SEPARATOR + next.text;
                    next.tokens = c.tokens + sepTokens + next.tokens;
                    i++;
                    continue;
                }
            }

            // 前后都不同 section → 保留为独立 chunk，不强制合并
        }
        result.push(c);
        i++;
    }
    return result;
}

/* ------------------------------------------------------------------ */
/* parent 自适应层级切分                                                 */
/* ------------------------------------------------------------------ */

/** 章节自身内容（不含子章节）单独成 parent，必要时按阈值切分 */
function collectOwnContentParents(
    section: Section,
    cfg: ChunkConfig,
): ParentBundle[] {
    if (section.blocks.length === 0) return [];
    const ownRefs: BlockRef[] = section.blocks.map((block) => ({
        block,
        sectionPath: section.sectionPath,
    }));
    const pieces = packPieces(
        piecesFromRefs(ownRefs, cfg.maxParentTokens),
        cfg.maxParentTokens,
        0,
    );
    const bundles: ParentBundle[] = [];
    pieces.forEach((piece, index) => {
        // 仅首个 parent 补章节标题，避免重复
        const headingLine =
            index === 0 && section.title
                ? headingText(section.depth, section.title)
                : '';
        const content = headingLine
            ? `${headingLine}\n\n${piece.text}`
            : piece.text;
        bundles.push({
            parent: {
                sectionPath: section.sectionPath,
                title: section.title,
                content,
                contentHash: generateContentHash(content),
            },
            refs: piece.refs,
        });
    });
    return bundles;
}

/** 单个章节 → parent 集合：整节（含全部子内容）不超阈值 → 单 parent，否则自身内容 + 递归子标题 */
function collectParents(section: Section, cfg: ChunkConfig): ParentBundle[] {
    if (section.totalTokens <= cfg.maxParentTokens) {
        const content = serializeSection(section);
        if (!content.trim()) return [];
        return [
            {
                parent: {
                    sectionPath: section.sectionPath,
                    title: section.title,
                    content,
                    contentHash: generateContentHash(content),
                },
                refs: flattenSection(section),
            },
        ];
    }

    const bundles: ParentBundle[] = [...collectOwnContentParents(section, cfg)];
    // 超阈值 → 递归子标题
    for (const child of section.children) {
        bundles.push(...collectParents(child, cfg));
    }
    return bundles;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

export function chunkMarkdown(
    markdown: string,
    config?: Partial<ChunkConfig>,
): ChunkResult {
    const startTime = Date.now();
    const cfg: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...config };
    const empty: ChunkResult = {
        parents: [],
        children: [],
        stats: {
            parentCount: 0,
            childCount: 0,
            avgChildTokens: 0,
            maxChildTokens: 0,
            minChildTokens: 0,
            forcedSplitCount: 0,
        },
    };
    if (!markdown || !markdown.trim()) return empty;

    const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    const sections = buildSections(tree);

    // 1. parents（文档序，0-based 编号）
    const bundles: ParentBundle[] = [];
    for (const section of sections) {
        if (section.children.length > 0) {
            // 有标题文档：根伪节点（depth 0）不聚合子标题。
            // 首标题前的正文单独成 parent，各顶层标题章节独立递归（顶层标题即 parent 边界）。
            bundles.push(...collectOwnContentParents(section, cfg));
            for (const child of section.children) {
                bundles.push(...collectParents(child, cfg));
            }
        } else {
            // 无标题文档：整个正文作为一个 section，按 token 阈值切分
            bundles.push(...collectParents(section, cfg));
        }
    }
    const parents: ParentChunk[] = bundles.map((bundle, index) => ({
        ...bundle.parent,
        chunkIndex: index,
    }));

    // 2. children（每个 parent 内部按结构单元 + token-aware 切分，chunkIndex 为文档内全局顺序）
    const children: ChildChunk[] = [];
    let forcedSplitCount = 0;
    bundles.forEach((bundle, parentIndex) => {
        forcedSplitCount += bundle.refs.filter(
            (ref) => ref.block.tokens > cfg.maxChildTokens,
        ).length;
        const pieces = piecesFromRefs(bundle.refs, cfg.maxChildTokens);
        const chunks = packPieces(
            pieces,
            cfg.maxChildTokens,
            cfg.minChildTokens,
        );
        for (const chunk of chunks) {
            if (!chunk.text.trim()) continue;
            const sectionPath =
                chunk.refs[0]?.sectionPath ?? bundle.parent.sectionPath;
            children.push({
                sectionPath,
                title: sectionPath[sectionPath.length - 1] ?? '',
                parentIndex,
                content: chunk.text,
                contentHash: generateContentHash(chunk.text),
                chunkIndex: children.length,
            });
        }
    });

    // 3. stats
    const childTokenCounts = children.map((child) =>
        countTokens(child.content),
    );
    const stats: ChunkStats = {
        parentCount: parents.length,
        childCount: children.length,
        avgChildTokens: childTokenCounts.length
            ? Math.round(
                  childTokenCounts.reduce((sum, n) => sum + n, 0) /
                      childTokenCounts.length,
              )
            : 0,
        maxChildTokens: childTokenCounts.length
            ? Math.max(...childTokenCounts)
            : 0,
        minChildTokens: childTokenCounts.length
            ? Math.min(...childTokenCounts)
            : 0,
        forcedSplitCount,
    };

    const durationMs = Date.now() - startTime;
    console.log('durationMs: ' + durationMs);
    return { parents, children, stats };
}
