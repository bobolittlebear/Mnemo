// LTM 三层触发统一配置源：集中所有 TTL / 阈值常量，并提供启动期不变式校验。
// 组件引用约定：DistributedLock / ProcessingGuard / TerminalStateManager /
// MessageCounter / SessionTimeoutScanner 应从本模块读取对应常量，禁止硬编码。

import { AI_CONFIG } from '@/utils/config';

export const memoryTriggerConfig = {
    /** 分布式锁 TTL（10s） */
    lockTtlMs: 10000,
    /** 防并发标记 TTL（300s） */
    processingTtlMs: 300000,
    /** 终态标记 TTL（24h，跟随 Session） */
    extractedTtlSec: 86400,
    /** L3 消息计数 TTL（24h） */
    msgCountTtlSec: 86400,
    /** L3 触发阈值（20条消息） */
    messageThreshold: 20,
    /** 非流式 LLM 超时上限（用于不变式校验，非实际超时配置） */
    llmTimeoutMaxMs: AI_CONFIG.DEFAULT_REQUEST_TIMEOUT,
    /** L2 超时阈值（3 天，个人知识库慢节奏记录：3 天内回来都算续记，L2 仅做极端兜底） */
    l2TimeoutSec: 60 * 60 * 24 * 3,
    /** L2 扫描周期（30 分钟，超时阈值已放宽至 3 天故降低扫描频率） */
    l2ScanIntervalSec: 1800,
};

/** LLM 之外的向量化/存储耗时余量（ms） */
export const PROCESSING_OVERHEAD_MS = 60000;

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
