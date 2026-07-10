// src/lib/retry.ts

import { DEFAULT_API_CONFIG } from '@/util/constant';
import type { Logger as WinstonLogger } from 'winston';

/**
 * 带指数退避 + 全抖动 + 完整错误覆盖的重试包装器
 * @param fn - 要重试的异步操作
 * @param attempts - 总尝试次数（含首次），默认 3 → 1次初始 + 2次重试
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: {
        attempts?: number;
        baseDelay?: number;
        maxDelay?: number;
        logger?: WinstonLogger; // 可选注入
    },
): Promise<T> {
    const {
        attempts = DEFAULT_API_CONFIG.MAX_RETRIES,
        baseDelay = DEFAULT_API_CONFIG.BASE_DELAY,
        maxDelay = DEFAULT_API_CONFIG.MAX_DELAY,
        logger,
    } = options || {};
    // 防护：attempts <= 0 时至少执行一次
    if (attempts <= 0) return fn();

    // 常见网络瞬态错误码（Node.js http/https/undici 体系）
    const NETWORK_ERROR_CODES = new Set([
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'EPIPE',
        'ECONNABORTED',
        'ERR_BAD_RESPONSE',
    ]);

    // 兼容 axios 的 cancel/timeout 码
    const ADDITIONAL_RETRYABLE_CODES = new Set([
        'ECONNABORTED', // axios 超时取消
        'ERR_CANCELED',
    ]);

    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error: any) {
            const status = error?.response?.status ?? error?.status;
            const code = error?.code;
            const isLastAttempt = i === attempts - 1;

            // ── 错误分类 ──────────────────────────────────────
            const isClientError =
                status != null &&
                status >= 400 &&
                status < 500 &&
                status !== 429;

            const isRateLimit = status === 429;
            const isServerError = status != null && status >= 500;
            const isNetworkError =
                NETWORK_ERROR_CODES.has(code) ||
                ADDITIONAL_RETRYABLE_CODES.has(code);

            // 没有 status 也没有 code → 兜底也重试一次（可能是异常形态的错误）
            const isUnknown = status == null && code == null;

            const isRetryable =
                isRateLimit || isServerError || isNetworkError || isUnknown;

            // ── 不可重试 → 记录日志后抛出 ─────────────────
            if (isClientError || !isRetryable) {
                logger?.error?.('Non-retryable error, aborting', {
                    error: error?.message ?? error,
                    status,
                    code,
                });
                throw error;
            }

            // ── 最后一次尝试也失败了 → 记录日志后抛出 ──────
            if (isLastAttempt) {
                logger?.error?.('All attempts exhausted', {
                    error: error?.message ?? error,
                    status,
                    code,
                    totalAttempts: attempts,
                });
                throw error;
            }

            // ── 指数退避 + full jitter ──────────────────────
            const delay = Math.round(
                Math.random() * Math.min(baseDelay * Math.pow(2, i), maxDelay),
            ); // full jitter: [0, baseDelay)

            logger?.warn?.('Retrying after error', {
                error: error?.message ?? error,
                status,
                code,
                attempt: i + 1,
                totalAttempts: attempts,
                delay,
            });

            await new Promise((r) => setTimeout(r, delay));
        }
    }

    // 理论上不可达（最后一次尝试失败已在 catch 中 throw），但保留兜底
    throw new Error('withRetry: unreachable');
}
