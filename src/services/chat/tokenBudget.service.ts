// src/services/chat/tokenBudget.service.ts
/**
 * Token 预算核心（M3）：ContextBudgeter
 *
 * 对应设计：.claude/design/token-budget.md §4–§7（must-fit / L0–L3 阶梯 / L1 逐出 / L2 压缩）
 *
 * 职责边界：把 system / userMessage / STM / LTM / RAG 的全部 token 处理集中到本类，
 * 其它 service 不得再写预算逻辑（设计 §11.1「单一职责」）。本类只做「算 + 裁 + 记账」：
 * - 不检索、不写库、不调 LLM（压缩是抽取式的）
 * - 不改 chatStream 装配（M4 集成），本文件不 import chatStream
 * - 不把瞬时分数（rrfScore / score）写进任何落库对象
 *
 * 三条硬约束（设计 §6 / §7）：
 * 1. 不跨块归一化：LTM 用 rrfScore、RAG 用 score，各自块内排序，不做全局混排；
 * 2. floor 是 L1 软下限（RAG top5 / LTM top4），L1 绝不跌破；进入 D3/L2 极端降级才允许跌破至 0；
 * 3. must-fit（system + 当前用户消息 + 最近 N 轮 STM）不可丢弃、不可永久截断，
 *    仅在 L2c 对本请求做临时抽取式压缩（非破坏、库中原文不动）。
 *
 * M4 消费方式：`assembleContext` 返回裁好的 finalMessages + systemPrompt + bill，
 * 并把「实际装入的 LTM / RAG」一并回传（`keptLtm` / `keptRag`）——账单与提示文本因此恒一致：
 * 调用方拿这两个列表喂 `buildSystemPrompt` 渲染，看到的条数/文本与 bill 记的完全同源，
 * 不会出现「账单说裁到 0、prompt 里还留着 4 条」的自欺。
 */
import {
    AI_MODEL,
    BUDGET_CONFIG,
    getCategoryTokenCap,
    getInputBudget,
} from '@/utils/config';
import { countTokens, truncateByTokens } from '@/utils/tokenizer';
import { createLogger } from '@/lib/logger';
import {
    buildNoteContextBlock,
    xmlEscape,
} from '@/services/notebook/noteBlock';
import type { MemorySearchResult } from '@/types/memory';
import type { NoteRetrievalResult } from '@/services/notebook/noteSearch.service';
import type { RawMessage } from '@/types/chat';

const logger = createLogger('ai');

/** 降级层级：L0 全量 → L1 逐出 → L2a/b/c 压缩与丢弃 → L3 报错（设计 §5） */
export type BudgetLevel = 'L0' | 'L1' | 'L2a' | 'L2b' | 'L2c' | 'L3';

/** 压缩层级：L2a/L2b 作用于 competitable，L2c 作用于 must-fitSTM */
export type CompressLevel = 'L2a' | 'L2b' | 'L2c';

/** 装配模式：写模式超限不报错，退化为「标题 + 笔记首部邻域」（设计 §9） */
export type BudgetMode = 'chat' | 'write';

/** 单块计量：used = 实际装入的 token，evicted = 被丢掉/被裁的条数，floor = 该块的 L1 保底条数 */
export interface BlockBill {
    used: number;
    evicted: number;
    floor: number;
}

/** 用量计量账单（设计 §10）：W3 埋点消费，属数据层，不参与装配决策 */
export interface BudgetBill {
    inputBudget: number;
    perBlock: {
        system: BlockBill;
        stm: BlockBill;
        ltm: BlockBill;
        rag: BlockBill;
    };
    level: BudgetLevel;
    mustFitCompressed: boolean;
}

/**
 * LTM 注入条目的最小形状。
 *
 * 刻意用结构类型而非 MemoryFact：真实链路里喂进来的是**选择层的输出**
 * （`MemorySearchResult`，本身已带 rrfScore，但不是 mongoose Document，
 * 且不携带落库缓存的 tokenCount），用 MemoryFact 会逼调用方做无谓断言。
 * 预算器只需要这几个字段：计 token、取 category 上限、渲染 learned 日期。
 */
export interface LtmFact {
    _id: unknown;
    content: string;
    category?: string;
    /** 落库缓存的 tokenCount；检索结果未带上时代码回退实时计数 */
    tokenCount?: number;
    createdAt?: Date | string;
}

export interface AssembleInput {
    /** system 提示（chat 模式下固定不裁、仅观测；写模式下超限才退化为邻域副本） */
    systemPrompt: string;
    /** 当前用户消息：must-fit，chat 模式下超预算直接报错 */
    userMessage: RawMessage;
    /** 短期记忆（扁平消息列表，带落库时缓存的 tokenCount），需已按时间正序 */
    stmRounds?: RawMessage[];
    /** LTM 候选（瞬时 rrfScore，不入库），来自 searchResult.results */
    scoredLtm?: MemorySearchResult[];
    /** LTM 选择层输出，与 scoredLtm 按 _id 关联拿 rrfScore（选择层已返回带 rrfScore 的条目，关联是防御性的） */
    selectedLtm?: LtmFact[];
    /** RAG 召回结果（score = rrfFuse） */
    scoredRag?: NoteRetrievalResult[];
    mode?: BudgetMode;
}

export interface BudgetedContext {
    finalMessages: RawMessage[];
    /** 可能被写模式退化过的 system 基底提示（不含 LTM / RAG 块，需由调用方拼接） */
    systemPrompt: string;
    bill: BudgetBill;
    /** 实际装入的 LTM 条目（与 bill.perBlock.ltm.used 同源，勿另行裁剪后渲染） */
    keptLtm: LtmFact[];
    /** 实际装入的 RAG 条目（与 bill.perBlock.rag.used 同源） */
    keptRag: NoteRetrievalResult[];
}

/** processSystemPrompt 的结果：system 只观测不裁，overBudget 供账单与埋点用 */
export interface SystemPromptResult {
    prompt: string;
    tokens: number;
    max: number;
    overBudget: boolean;
    degraded: boolean;
}

export interface UserMessageResult {
    message: RawMessage;
    tokens: number;
    overBudget: boolean;
}

/**
 * L3 失败错误：错误对象上挂 level + bill。
 * 抛错路径也必须有账单——超预算的复盘价值全在「哪块吃掉了多少」。
 */
export type BudgetExceededError = Error & {
    level: 'L3';
    bill: BudgetBill;
};

/** join 后的 LTM 条目：事实 + 其瞬时检索分（排序键，绝不落库） */
interface ScoredFact {
    fact: LtmFact;
    rrfScore: number;
}

/**
 * 压缩比：目标 token 未显式给出时的兜底。
 * L2c 作用于 must-fitSTM——降级链的最后手段，比 competitable 压得更狠（0.3 vs 0.5）。
 */
const COMPRESS_RATIO: Record<CompressLevel, number> = {
    L2a: 0.5,
    L2b: 0.5,
    L2c: 0.3,
};

/**
 * 抽出可压缩的「中间段」索引：首尾各留一条完整（抽取式压缩不丢首尾，
 * 保住最新一轮指令的答复与最旧一轮的起点），中间整段是可牺牲的铺垫。
 */
function middleRange(length: number): [number, number] {
    if (length <= 2) return [1, 1];
    return [1, length - 1];
}

/** 按 token 预算把消息列表整体等比缩一遍（仅在首尾段自身超预算时兜底触发） */
function scaleDown(
    messages: RawMessage[],
    sizes: number[],
    budget: number,
): RawMessage[] {
    const total = sizes.reduce((sum, n) => sum + n, 0);
    if (total <= budget || total === 0) return messages;
    const factor = budget / total;
    return messages.map((m, i) => {
        const target = Math.max(0, Math.floor(sizes[i]! * factor));
        const content = truncateByTokens(m.content ?? '', target);
        return { ...m, content, tokenCount: countTokens(content) };
    });
}

/**
 * 上下文预算器：单例逻辑集中在此，模型规格与限值全部取自 config，不写死魔法值。
 */
export class ContextBudgeter {
    /** 模型名（登记在 MODEL_REGISTRY 中） */
    readonly model: string;

    /** 单轮输入预算 = maxInput − maxOutput − margin（config §2） */
    readonly inputBudget: number;

    constructor(model: string = AI_MODEL) {
        this.model = model;
        // 未登记模型直接抛错，不静默兜底（预算错了比崩溃更危险）
        this.inputBudget = getInputBudget(this.model);
    }

    // ────────────────────────── 块内计数 ──────────────────────────

    /**
     * 消息 token 数：优先读落库缓存，存量行回退实时计数。
     * 预算器只读求和，不每次重算（设计 §8）——重算仅作缓存缺失时的兜底。
     */
    private messageTokens(
        msg: Pick<RawMessage, 'content' | 'tokenCount'>,
    ): number {
        return msg.tokenCount ?? countTokens(msg.content ?? '');
    }

    private sumMessages(messages: RawMessage[]): number {
        return messages.reduce((sum, m) => sum + this.messageTokens(m), 0);
    }

    /**
     * RAG 单块的注入成本 = 父块正文 + 父块上下文。
     * injectNotesIntoSystemPrompt 的 <note> 块两者都会下发，少算父块上下文会低估用量。
     * NoteRetrievalResult 不带 tokenCount（父块计数落在 NoteChunk 上，未随检索结果传出），
     * 故这里按实际注入文本实时计数。
     */
    private ragChunkTokens(chunk: NoteRetrievalResult): number {
        return (
            countTokens(chunk.content ?? '') +
            countTokens(chunk.parentContext ?? '')
        );
    }

    // ────────────────────────── 1. system ──────────────────────────

    /**
     * system 提示：chat 模式固定不裁，只计数 + 记账（设计 §3「半固定」，M3 任务书明确不静默裁）。
     * 写模式例外：笔记全文超限会退化为「标题 + 笔记首部邻域」的抽取式副本，
     * 整体丢弃会让工具调用失去锚点（设计 §9）。
     *
     * @param cap 写模式退化的目标上限，缺省为整个 inputBudget；
     *            assembleContext 会传入「inputBudget − 当前用户消息」，给 must-fit 的用户消息留位。
     */
    processSystemPrompt(
        systemPrompt: string,
        mode: BudgetMode = 'chat',
        cap: number = this.inputBudget,
    ): SystemPromptResult {
        const max = Math.floor(BUDGET_CONFIG.systemMaxRatio * this.inputBudget);
        const tokens = countTokens(systemPrompt);
        const overBudget = tokens > max;
        if (overBudget) {
            logger.warn('system 提示超出比例上限，仅观测不裁剪', {
                mode,
                tokens,
                max,
                ratio: BUDGET_CONFIG.systemMaxRatio,
            });
        }
        // 写模式的退化闸门按「模型整体输入预算」判，而非 10% 比例——
        // 写模式 system 就是笔记全文本体，用比例会把它常态性压掉。
        if (mode === 'write' && tokens > cap) {
            const prompt = truncateByTokens(systemPrompt, Math.max(0, cap));
            logger.warn('写模式笔记全文超模型输入上限，退化为标题 + 首部邻域', {
                tokens,
                cap,
                inputBudget: this.inputBudget,
                degradedTokens: countTokens(prompt),
            });
            return {
                prompt,
                tokens: countTokens(prompt),
                max,
                overBudget,
                degraded: true,
            };
        }
        return {
            prompt: systemPrompt,
            tokens,
            max,
            overBudget,
            degraded: false,
        };
    }

    // ────────────────────────── 2. userMessage ──────────────────────────

    /**
     * 当前用户消息：must-fit。静默截断会丢用户原话，故 chat 模式超预算直接报错（设计 §4）。
     * 写模式的用户消息同样不裁——超限由 system（笔记全文）侧的退化承担。
     */
    processUserMessage(
        userMessage: RawMessage,
        mode: BudgetMode = 'chat',
    ): UserMessageResult {
        const tokens = this.messageTokens(userMessage);
        const overBudget = tokens > this.inputBudget;
        if (overBudget && mode === 'chat') {
            // 与 L3 同形：预算不可满足的失败一律带 level + bill，
            // 调用方（chatStream / 埋点）不必区分是「用户消息自身」还是「system+用户」超限。
            // 此处尚未装配任何块，各块用量为 0——账单里唯一有意义的是 inputBudget 这条上限。
            const error: BudgetExceededError = Object.assign(
                new Error(
                    `当前用户消息超出模型输入预算（${tokens} > ${this.inputBudget} token），请求不可满足`,
                ),
                { level: 'L3' as const, bill: this.emptyBill(0) },
            );
            logger.error('用户消息自身超出输入预算', {
                error,
                tokens,
                inputBudget: this.inputBudget,
            });
            throw error;
        }
        return { message: userMessage, tokens, overBudget };
    }

    // ────────────────────────── 3. LTM 裁剪 ──────────────────────────

    /**
     * 按 _id 把瞬时 rrfScore 关联到选择层输出上，并按分数降序（稳定排序，同分保持原序）。
     * 关联不上的（理论上不该出现）给 0 分排在末尾，宁可先裁也不误裁有分数的。
     */
    private joinLtmScores(
        scored: MemorySearchResult[],
        selected: LtmFact[],
    ): ScoredFact[] {
        const scoreById = new Map(scored.map((s) => [s._id, s.rrfScore]));
        return selected
            .map((fact) => ({
                fact,
                rrfScore: scoreById.get(String(fact._id)) ?? 0,
            }))
            .sort((a, b) => b.rrfScore - a.rrfScore);
    }

    /**
     * 注入副本的防御截断：category 上限（config.ltmCategoryTokenCap）只作用于喂模型的那份副本，
     * 库中原文不动、条数不减、可逆（设计 §3 / §8）。未超限时原样返回，不制造无谓副本。
     */
    private capFact(fact: LtmFact): LtmFact {
        const content = fact.content ?? '';
        const maxTokens = getCategoryTokenCap(fact.category)[1];
        const tokens = fact.tokenCount ?? countTokens(content);
        if (tokens <= maxTokens) return fact;
        const truncated = truncateByTokens(content, maxTokens);
        return {
            ...fact,
            content: truncated,
            tokenCount: countTokens(truncated),
        };
    }

    /**
     * LTM 裁剪：块内按 rrfScore 降序，保留 top `floor` 为 L1 硬地板；
     * 超出 `maxTokens` 时从低分端逐条逐出，直到放得下或触到地板。
     *
     * 地板是 L1 的软下限——本方法绝不裁到 floor 以下；跌破至 0 由 assembleContext
     * 在 D3/L2 极端降级分支里显式执行（可选块本就是 D2 超额来源）。
     */
    trimLtmFacts(
        scored: MemorySearchResult[],
        selected: LtmFact[],
        floor: number = BUDGET_CONFIG.ltmFloor,
        maxTokens: number = Number.POSITIVE_INFINITY,
    ): LtmFact[] {
        const ordered = this.joinLtmScores(scored, selected);
        const kept: LtmFact[] = [];
        let used = 0;
        // 先按分序全量装入（副本化），再从低分端逐出——顺序即优先级
        for (const { fact } of ordered) {
            const copy = this.capFact(fact);
            kept.push(copy);
            used += this.messageTokens(copy);
        }
        while (kept.length > floor && used > maxTokens) {
            const dropped = kept.pop();
            if (dropped) used -= this.messageTokens(dropped);
        }
        return kept;
    }

    // ────────────────────────── 4. RAG 裁剪 ──────────────────────────

    /**
     * RAG 裁剪：块内按 score（rrfFuse）降序，保留 top `floor` 为地板，
     * 超 `maxTokens` 时从低分端逐条逐出。与 LTM 同构，但排序键是各自块的原生分数，
     * 不跨块归一化（设计 §6）。
     */
    trimRagChunks(
        scored: NoteRetrievalResult[],
        floor: number = BUDGET_CONFIG.ragFloor,
        maxTokens: number = Number.POSITIVE_INFINITY,
    ): NoteRetrievalResult[] {
        const ordered = [...scored].sort((a, b) => b.score - a.score);
        const kept: NoteRetrievalResult[] = [];
        let used = 0;
        for (const chunk of ordered) {
            kept.push(chunk);
            used += this.ragChunkTokens(chunk);
        }
        while (kept.length > floor && used > maxTokens) {
            const dropped = kept.pop();
            if (dropped) used -= this.ragChunkTokens(dropped);
        }
        return kept;
    }

    // ────────────────────────── 5. 抽取式压缩 ──────────────────────────

    /**
     * 抽取式压缩（非 LLM、非破坏）：首尾各留一条完整，中间段按预算均摊后逐个 truncateByTokens。
     * 中间段被压到 0 仍超时，才兜底等比缩放整段（此时才会动首尾）——L2c 的最后一道保证。
     *
     * @param level L2a/L2b 作用于 competitable（比 0.5），L2c 作用于 must-fitSTM（比 0.3）
     * @param targetTokens 显式目标；缺省按 level 的压缩比从当前总量折算
     * @returns 新数组（原数组与元素对象均不改写，存储原文不受影响）
     */
    compressMustFit(
        messages: RawMessage[],
        level: CompressLevel,
        targetTokens?: number,
    ): RawMessage[] {
        if (messages.length === 0) return [];
        const sizes = messages.map((m) => this.messageTokens(m));
        const total = sizes.reduce((sum, n) => sum + n, 0);
        const budget =
            targetTokens ??
            Math.max(0, Math.floor(total * COMPRESS_RATIO[level]));
        if (total <= budget) return messages.map((m) => ({ ...m }));

        const [from, to] = middleRange(messages.length);
        const headTail = sizes.slice(0, from).concat(sizes.slice(to));
        const middleSizes = sizes.slice(from, to);
        // 首尾完整保留，剩余预算在中间段均摊；中间段为空时预算全给首尾
        const middleBudget = Math.max(
            0,
            budget - headTail.reduce((s, n) => s + n, 0),
        );
        const share =
            middleSizes.length > 0
                ? Math.floor(middleBudget / middleSizes.length)
                : 0;

        const out = messages.map((m, i) => {
            const isMiddle = i >= from && i < to && middleSizes.length > 0;
            if (!isMiddle) return { ...m };
            const content = truncateByTokens(m.content ?? '', share);
            return { ...m, content, tokenCount: countTokens(content) };
        });

        const outSizes = out.map((m) => this.messageTokens(m));
        const outTotal = outSizes.reduce((sum, n) => sum + n, 0);
        if (outTotal <= budget) return out;
        return scaleDown(out, outSizes, budget);
    }

    // ────────────────────────── 6. 装配编排 ──────────────────────────

    /** STM 拆分为 competitable（可压缩可丢弃）与 must-fit（最近 N 轮）两段 */
    private splitStmRounds(
        messages: RawMessage[],
        mustFitRounds: number,
    ): { competitable: RawMessage[]; mustFit: RawMessage[] } {
        let seen = 0;
        let splitAt = 0;
        // 以 user 消息为轮次基准，与 STM.getRecentRounds 的计数口径一致
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]!.role === 'user') {
                seen += 1;
                if (seen >= mustFitRounds) {
                    splitAt = i;
                    break;
                }
            }
        }
        return {
            competitable: messages.slice(0, splitAt),
            mustFit: messages.slice(splitAt),
        };
    }

    /**
     * 逐出可选块至地板：从低分端逐条丢弃，每步重算 fit，fit 即停；绝不跌破 floor。
     * `fits` 是闭包形式的全局 fit 判据（各块用量随逐出变化）。
     */
    private evictToFloor<T>(
        list: T[],
        floor: number,
        fits: () => boolean,
        maxTokens?: number,
        tokenOf?: (item: T) => number,
    ): T[] {
        const kept = [...list];
        const overTokenCap = () =>
            maxTokens !== undefined &&
            tokenOf !== undefined &&
            kept.reduce((s, it) => s + tokenOf(it), 0) > maxTokens;
        // 逐出条件：超过全局预算「或」超过指定 token 上限（如 RAG 的 ragMaxRatio 天花板）；
        // 二者任一成立且仍高于 floor 就继续滚删，确保天花板（软）与 floor（硬下限）同时生效。
        while (kept.length > floor && (!fits() || overTokenCap())) kept.pop();
        return kept;
    }

    private buildBill(props: {
        level: BudgetLevel;
        systemTokens: number;
        systemFloor: number;
        stm: { used: number; evicted: number };
        ltm: { used: number; evicted: number };
        rag: { used: number; evicted: number };
        mustFitCompressed: boolean;
    }): BudgetBill {
        return {
            inputBudget: this.inputBudget,
            perBlock: {
                system: {
                    used: props.systemTokens,
                    evicted: 0,
                    floor: props.systemFloor,
                },
                stm: { ...props.stm, floor: BUDGET_CONFIG.mustFitRecentRounds },
                ltm: { ...props.ltm, floor: BUDGET_CONFIG.ltmFloor },
                rag: { ...props.rag, floor: BUDGET_CONFIG.ragFloor },
            },
            level: props.level,
            mustFitCompressed: props.mustFitCompressed,
        };
    }

    /** 还没开始装配时的空账单（L3 失败路径用）：各块 0，只有 inputBudget 与 level 有意义 */
    private emptyBill(systemTokens: number): BudgetBill {
        return this.buildBill({
            level: 'L3',
            systemTokens,
            systemFloor: 0,
            stm: { used: 0, evicted: 0 },
            ltm: { used: 0, evicted: 0 },
            rag: { used: 0, evicted: 0 },
            mustFitCompressed: false,
        });
    }

    /**
     * 按设计 §5 流程图编排 L0–L3，返回裁好的上下文与计量账单。
     *
     * 每步重算 fit 作防御校验；确定性成功，无随机性——同一输入必得同一层级与账单。
     */
    assembleContext(input: AssembleInput): BudgetedContext {
        const started = Date.now();
        const {
            systemPrompt,
            userMessage,
            stmRounds = [],
            scoredLtm = [],
            selectedLtm = [],
            scoredRag = [],
            mode = 'chat',
        } = input;

        // ── 计数 + 算 inputBudget ──
        // 用户消息先算：写模式的 system 退化上限要让位给 must-fit 的用户消息
        const userTokens = this.processUserMessage(userMessage, mode).tokens;
        const sys = this.processSystemPrompt(
            systemPrompt,
            mode,
            this.inputBudget - userTokens,
        );
        const systemTokens = sys.tokens;

        // 全量候选（按各自原生分数降序：LTM 用 rrfScore、RAG 用 score，不跨块归一化）
        const ltmAll = this.trimLtmFacts(
            scoredLtm,
            selectedLtm,
            0,
            Number.POSITIVE_INFINITY,
        );
        const ragAll = this.trimRagChunks(
            scoredRag,
            0,
            Number.POSITIVE_INFINITY,
        );
        const ltmPool = [...ltmAll];
        const ragPool = [...ragAll];

        const { competitable, mustFit } = this.splitStmRounds(
            stmRounds,
            BUDGET_CONFIG.mustFitRecentRounds,
        );
        const mustFitTokens = this.sumMessages(mustFit);
        const competTokens = this.sumMessages(competitable);

        // 可变状态：各块的当前装入清单（fit 判据随逐出/压缩实时重算）
        let ltm: LtmFact[] = ltmPool;
        let rag: NoteRetrievalResult[] = ragPool;
        let stm: RawMessage[] = stmRounds;
        let level: BudgetLevel = 'L0';
        let mustFitCompressed = false;

        const ltmTokens = () =>
            ltm.reduce((s, f) => s + this.messageTokens(f), 0);
        const ragTokens = () =>
            rag.reduce((s, c) => s + this.ragChunkTokens(c), 0);
        const used = () =>
            systemTokens +
            userTokens +
            this.sumMessages(stm) +
            ltmTokens() +
            ragTokens();
        const fits = () => used() <= this.inputBudget;

        /**
         * L3 也要给账单：抛错前调用方（chatStream 埋点 / 测试）需要能读到 level 与各块用量，
         * 否则「超预算」只剩一句错误信息，线上无法复盘是被哪一块撑爆的。
         */
        const l3Bill = (compressed: boolean): BudgetBill =>
            this.buildBill({
                level: 'L3',
                systemTokens,
                systemFloor: 0,
                stm: {
                    used: this.sumMessages(stm),
                    evicted: stmRounds.length - stm.length,
                },
                ltm: {
                    used: ltmTokens(),
                    evicted: ltmPool.length - ltm.length,
                },
                rag: {
                    used: ragTokens(),
                    evicted: ragPool.length - rag.length,
                },
                mustFitCompressed: compressed,
            });

        // ── D1 全量 fit？ ──
        // RAG 逐块硬天花板（与设计「RAG ≤25% 真伸缩」一致）：L1 阶段作为次级约束接入逐出，
        // 与全局预算、块数下限（ragFloor）同处一个循环——有余量时收紧，低于 floor 的 token
        // 当量时让位给 floor（软天花板、硬下限）。
        const ragCeiling = Math.floor(
            this.inputBudget * BUDGET_CONFIG.ragMaxRatio,
        );
        if (!fits()) {
            // ── L1 逐步逐出可选块：RAG 低分先出，再动 LTM；尊重 floor，每步重算 ──
            level = 'L1';
            rag = this.evictToFloor(
                ragPool,
                BUDGET_CONFIG.ragFloor,
                fits,
                ragCeiling,
                (chunk) => this.ragChunkTokens(chunk),
            );
            if (!fits()) {
                ltm = this.evictToFloor(ltmPool, BUDGET_CONFIG.ltmFloor, fits);
            }

            // ── D2 L1 后 fit？ ──
            if (!fits()) {
                // ── D3 硬 must-fit + competitable ≤ budget？（即：除可选块外全放得下） ──
                const coreTokens =
                    systemTokens + userTokens + mustFitTokens + competTokens;
                if (coreTokens <= this.inputBudget) {
                    // D3=是：核心放得下 → 可选块跌破 floor 至 0，competitable 原样保留
                    ltm = [];
                    rag = [];
                } else {
                    // D3=否：可选块先跌破 floor 至 0，再走 L2 三级递进
                    ltm = [];
                    rag = [];

                    // ── L2a 压缩 competitable ──
                    const competTarget = Math.max(
                        0,
                        this.inputBudget -
                            systemTokens -
                            userTokens -
                            mustFitTokens,
                    );
                    stm = [
                        ...this.compressMustFit(
                            competitable,
                            'L2a',
                            competTarget,
                        ),
                        ...mustFit,
                    ];
                    if (fits()) {
                        level = 'L2a';
                    } else {
                        // ── L2b 整体丢弃 competitable：仅剩硬 must-fit ──
                        stm = [...mustFit];
                        if (fits()) {
                            level = 'L2b';
                        } else if (
                            systemTokens + userTokens >
                            this.inputBudget
                        ) {
                            // ── C1 否：system + 用户消息自身超预算 → L3 ──
                            this.throwBudgetExceeded(
                                { systemTokens, userTokens, mustFitTokens },
                                l3Bill(false),
                            );
                        } else {
                            // ── L2c 对 must-fitSTM 做临时抽取式压缩 ──
                            const mustFitTarget = Math.max(
                                0,
                                this.inputBudget - systemTokens - userTokens,
                            );
                            stm = this.compressMustFit(
                                mustFit,
                                'L2c',
                                mustFitTarget,
                            );
                            if (fits()) {
                                level = 'L2c';
                                mustFitCompressed = true;
                            } else {
                                // 压过 must-fit 仍放不下 → L3；账单记 compressed=true（确实压过）
                                this.throwBudgetExceeded(
                                    {
                                        systemTokens,
                                        userTokens,
                                        mustFitTokens,
                                    },
                                    l3Bill(true),
                                );
                            }
                        }
                    }
                }
            }
        }

        const finalMessages: RawMessage[] = [...stm, userMessage];
        const bill = this.buildBill({
            level,
            systemTokens,
            systemFloor: 0,
            stm: {
                used: this.sumMessages(stm),
                evicted: stmRounds.length - stm.length,
            },
            ltm: {
                used: ltmTokens(),
                evicted: ltmPool.length - ltm.length,
            },
            rag: {
                used: ragTokens(),
                evicted: ragPool.length - rag.length,
            },
            mustFitCompressed,
        });

        const totalTokens = used();
        const logPayload = {
            mode,
            model: this.model,
            level,
            inputBudget: this.inputBudget,
            totalTokens,
            mustFitCompressed,
            perBlock: bill.perBlock,
            duration_ms: Date.now() - started,
        };
        if (level === 'L0') {
            logger.info('上下文预算装配完成（L0 全量装配）', logPayload);
        } else {
            logger.warn('上下文预算触发降级', logPayload);
        }

        return {
            finalMessages,
            systemPrompt: sys.prompt,
            bill,
            keptLtm: ltm,
            keptRag: rag,
        };
    }

    /** L3：预算不可满足，响亮失败（不静默截断 must-fit） */
    private throwBudgetExceeded(
        parts: {
            systemTokens: number;
            userTokens: number;
            mustFitTokens: number;
        },
        bill: BudgetBill,
    ): never {
        const error: BudgetExceededError = Object.assign(
            new Error(
                `上下文超出模型输入预算：system ${parts.systemTokens} + 用户消息 ${parts.userTokens} ` +
                    `+ 最近轮 STM ${parts.mustFitTokens} > ${this.inputBudget} token，请求不可满足`,
            ),
            { level: 'L3' as const, bill },
        );
        logger.error('上下文超出输入预算，L3 报错', {
            error,
            inputBudget: this.inputBudget,
            ...parts,
        });
        throw error;
    }
}

// ────────────────────────── 7. system prompt 渲染 ──────────────────────────

/** 记忆注入指令模板：与 M4 之前 chatStream 的内联版本逐字一致，抽成常量以便单测断言 */
const MEMORY_INSTRUCTIONS = `<memory_instructions>
请基于以下用户记忆提供个性化回答：
- 将记忆信息自然融入回答中，不要刻意提及"根据记忆"等表述
- 如果记忆与用户当前表述矛盾，以用户当前表述为准
- 不要编造记忆中没有的信息
</memory_instructions>`;

/** 记忆的 learned 日期：只取 YYYY-MM-DD，避免同一事实跨日重复注入时提示词漂移 */
function formatDate(value: Date | string): string {
    return new Date(value).toISOString().slice(0, 10);
}

/**
 * LTM → <memory_instructions> + <user_memory> 块（纯函数）。
 * 空列表返回空串——不注入空壳块（count="0" 的 <user_memory> 只会白烧 token）。
 */
export function buildMemoryBlock(facts: LtmFact[]): string {
    if (facts.length === 0) return '';
    const today = new Date().toISOString().slice(0, 10);
    const memsXml = facts
        .map((fact) => {
            const learned = fact.createdAt
                ? ` learned="${formatDate(fact.createdAt)}"`
                : '';
            return `<mem category="${xmlEscape(fact.category ?? '')}"${learned}>${xmlEscape(fact.content)}</mem>`;
        })
        .join('\n');
    return `${MEMORY_INSTRUCTIONS}
<user_memory count="${facts.length}" retrieved_at="${today}">
${memsXml}
</user_memory>`;
}

/**
 * 纯函数：把 system 基底 + 裁剪后的 LTM / RAG 渲染成最终下发的 system prompt。
 *
 * 输入必须是**预算器实际装入的那一份**（assembleContext 的 keptLtm / keptRag）：
 * 渲染与账单同源，否则会出现「账单记 0 条、提示词里还留着 4 条」的错位。
 * 三部分都为空时返回 ''，由调用方决定是否省略 system message。
 *
 * @param base 调用方自己的基座提示（chat 模式通常为 ''；写模式为笔记全文）
 * @param trimmedLTM 预算器装入的记忆条目
 * @param trimmedRAG 预算器装入的笔记块
 */
export function buildSystemPrompt(
    base: string,
    trimmedLTM: LtmFact[],
    trimmedRAG: NoteRetrievalResult[],
): string {
    const parts: string[] = [];
    if (base) parts.push(base);
    const memoryBlock = buildMemoryBlock(trimmedLTM);
    if (memoryBlock) parts.push(memoryBlock);
    const noteBlock = buildNoteContextBlock(trimmedRAG);
    if (noteBlock) parts.push(noteBlock);
    return parts.join('\n\n');
}

export default ContextBudgeter;
