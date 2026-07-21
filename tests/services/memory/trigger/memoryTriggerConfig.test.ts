import { describe, it, expect } from 'vitest';
import {
    memoryTriggerConfig,
    validateConfigInvariants,
} from '@/services/memory/trigger/memoryTriggerConfig';

describe('memoryTriggerConfig', () => {
    describe('validateConfigInvariants', () => {
        it('默认配置通过校验（不抛）', () => {
            expect(() => validateConfigInvariants()).not.toThrow();
        });

        it('processingTtlMs < 2*llmTimeoutMaxMs + overhead 时抛错且错误信息含关键数值', () => {
            const bad = { ...memoryTriggerConfig, processingTtlMs: 100000 };
            const required = 2 * memoryTriggerConfig.llmTimeoutMaxMs + 15000;
            expect(() => validateConfigInvariants(bad)).toThrow(
                /processingTtlMs\(100000\).*2\*llmTimeoutMaxMs\(120000\).*overhead\(15000\)/,
            );
            // 进一步确认错误信息包含计算出的 required 值（255000）
            expect(() => validateConfigInvariants(bad)).toThrow(
                String(required),
            );
        });

        it('processingTtlMs 恰好等于 required 时不抛（边界）', () => {
            const edge = {
                ...memoryTriggerConfig,
                processingTtlMs:
                    2 * memoryTriggerConfig.llmTimeoutMaxMs + 15000,
            };
            expect(() => validateConfigInvariants(edge)).not.toThrow();
        });

        it('messageThreshold = 0 时抛错', () => {
            const bad = { ...memoryTriggerConfig, messageThreshold: 0 };
            expect(() => validateConfigInvariants(bad)).toThrow(/必须为正/);
        });

        it('lockTtlMs = 0 时抛错', () => {
            const bad = { ...memoryTriggerConfig, lockTtlMs: 0 };
            expect(() => validateConfigInvariants(bad)).toThrow(/必须为正/);
        });

        it('extractedTtlSec 为负时抛错', () => {
            const bad = { ...memoryTriggerConfig, extractedTtlSec: -1 };
            expect(() => validateConfigInvariants(bad)).toThrow(/必须为正/);
        });
    });
});
