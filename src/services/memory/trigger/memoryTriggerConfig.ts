// LTM 三层触发统一配置源：集中所有 TTL / 阈值常量，并提供启动期不变式校验。
// 组件引用约定：DistributedLock / ProcessingGuard / TerminalStateManager /
// MessageCounter / SessionTimeoutScanner 应从本模块读取对应常量，禁止硬编码。

import { AI_CONFIG } from '@/utils/config';

export const memoryTriggerConfig = {
    lockTtlMs: 10000, // 分布式锁 TTL（10s）
    processingTtlMs: 300000, // 防并发标记 TTL（300s）
    extractedTtlSec: 86400, // 终态标记 TTL（24h，跟随 Session）
    msgCountTtlSec: 86400, // L3 消息计数 TTL（24h）
    messageThreshold: 20, // L3 触发阈值（条消息，v3 口径）
    llmTimeoutMaxMs: AI_CONFIG.DEFAULT_REQUEST_TIMEOUT, // 非流式 LLM 超时上限（用于不变式校验，非实际超时配置）
    l2TimeoutSec: 1800, // L2 超时阈值（30 分钟）
    l2ScanIntervalSec: 300, // L2 扫描周期（5 分钟）
};

// LLM 之外的向量化/存储耗时余量（ms）
const PROCESSING_OVERHEAD_MS = 15000;

export function validateConfigInvariants(
    cfg: typeof memoryTriggerConfig = memoryTriggerConfig,
): void {
    // 核心不变式：processing 必须覆盖 2× LLM 超时 + 余量
    const required = 2 * cfg.llmTimeoutMaxMs + PROCESSING_OVERHEAD_MS;
    if (cfg.processingTtlMs < required) {
        throw new Error(
            `processingTtlMs(${cfg.processingTtlMs}) 必须满足 >= 2*llmTimeoutMaxMs(${cfg.llmTimeoutMaxMs}) + overhead(${PROCESSING_OVERHEAD_MS}) = ${required}。将来上调 LLM 超时上限时，优先调大 processingTtlMs 而非加续期。`,
        );
    }

    // 辅助合理性校验
    if (
        cfg.lockTtlMs <= 0 ||
        cfg.extractedTtlSec <= 0 ||
        cfg.messageThreshold <= 0
    ) {
        throw new Error(
            'lockTtlMs / extractedTtlSec / messageThreshold 必须为正',
        );
    }
}

// 建议在应用启动期（如 trigger 模块初始化时）调用一次 validateConfigInvariants()
