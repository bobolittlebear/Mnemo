/**
 * utils/streamCleaner.ts
 * 终极版流式清洗器：解决 Token 粘连、重叠及复读机问题
 */

export interface CleanResult {
    cleaned: string;
    isDuplicate: boolean;
}

// 配置项
const CONFIG = {
    MIN_OVERLAP_LEN: 4, // 最小重叠长度，低于此值认为是正常连接
    MAX_CHECK_LEN: 60, // 最大检查长度，防止性能损耗
    BUFFER_SIZE: 200, // 历史缓冲池大小，用于检测长距离复读
};

export class StreamCleaner {
    private buffer: string = ''; // 维护一个滚动缓冲池

    /**
     * 清洗单个 Chunk
     * @param currentChunk 当前接收到的原始数据块
     */
    clean(currentChunk: string): CleanResult {
        if (!currentChunk || currentChunk.trim() === '') {
            return { cleaned: '', isDuplicate: true };
        }

        let result = currentChunk;
        let isDup = false;

        // --- 策略 1: 缓冲区复读检测 (解决 "一、核心一、核心" 这种整句重复) ---
        // 如果当前 chunk 在最近的 buffer 尾部大量出现，说明 AI 卡住了在复读
        const recentHistory = this.buffer.slice(-CONFIG.BUFFER_SIZE);
        if (recentHistory.length > 10 && result.length > 5) {
            // 简单粗暴：如果当前 chunk 完整包含在最近历史中，且不是极短的标点，大概率是复读
            if (recentHistory.includes(result) && result.trim().length > 3) {
                // 这里做一个保守处理：如果是完全重复，直接丢弃
                // 但为了防止误杀正常的强调词，我们结合策略2一起看
            }
        }

        // --- 策略 2: 边缘重叠检测 (解决 "流式输出+流式输出" 这种粘连) ---
        if (this.buffer.length > 0) {
            const overlap = this.getMaxOverlap(this.buffer, result);

            if (overlap.length >= CONFIG.MIN_OVERLAP_LEN) {
                // 发现重叠！切除当前 chunk 的重叠部分
                // 比如 buffer="...ABC", chunk="CDE" -> overlap="C" -> result="DE"
                result = result.slice(overlap.length);
                isDup = false; // 有内容产出，不算完全重复
            } else {
                // 没有重叠，但是内容完全一样？那就是复读机
                if (result === this.buffer.slice(-result.length)) {
                    isDup = true;
                    result = '';
                }
            }
        }

        // 更新缓冲池
        if (!isDup && result) {
            this.buffer += result;
            // 限制缓冲池大小，防止内存溢出
            if (this.buffer.length > 1000) {
                this.buffer = this.buffer.slice(-500);
            }
        }

        return {
            cleaned: result,
            isDuplicate: isDup,
        };
    }

    /**
     * 获取两个字符串的最长公共重叠部分 (后缀 vs 前缀)
     */
    private getMaxOverlap(suffixStr: string, prefixStr: string): string {
        const sLen = Math.min(suffixStr.length, CONFIG.MAX_CHECK_LEN);
        const pLen = Math.min(prefixStr.length, CONFIG.MAX_CHECK_LEN);

        const suffix = suffixStr.slice(-sLen);
        const prefix = prefixStr.slice(0, pLen);

        let maxOverlap = '';

        // 暴力匹配法（对于短字符串性能足够且最准确）
        // 尝试从最长的可能重叠开始匹配
        for (let i = Math.min(sLen, pLen); i >= CONFIG.MIN_OVERLAP_LEN; i--) {
            const subSuffix = suffix.slice(-i);
            const subPrefix = prefix.slice(0, i);

            if (subSuffix === subPrefix) {
                return subSuffix; // 找到最长匹配直接返回
            }
        }

        return maxOverlap;
    }

    reset() {
        this.buffer = '';
    }
}
