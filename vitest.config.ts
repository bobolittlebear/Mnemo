/**
 * Vitest 配置
 *
 * 安装：pnpm add -D vitest
 *
 * package.json scripts:
 *   "test": "vitest run",
 *   "test:watch": "vitest",
 *   "test:unit": "vitest run --dir tests/unit",
 *   "test:integration": "vitest run --dir tests/integration",
 *   "test:coverage": "vitest run --coverage"
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import dotenv from 'dotenv';

// 加载开发环境变量（测试也需要 MONGODB_URI、AI_API_KEY 等配置）
dotenv.config({ path: '.env.development' });

export default defineConfig({
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    test: {
        // 全局环境
        environment: 'node',

        // 改为相对模式，兼容 --dir tests/unit 和 --dir tests/integration
        include: ['**/*.test.ts'],

        // exclude 也改为相对模式
        exclude: ['node_modules/**'],
        // 排除集成测试（仅 pnpm test:integration 时跑）
        // exclude: ['tests/integration/**', 'node_modules/**'],

        // 全局 setup
        setupFiles: [],

        // 超时：单元测试 5s，集成测试 30s
        testTimeout: 5000,
        // hook 超时：集成测试 beforeAll 需连 Atlas 云数据库，给足时间
        hookTimeout: 30000,

        // 覆盖率配置
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/services/memory/**/*.ts', 'src/types/memory.ts'],
            exclude: ['tests/**', 'src/**/*.d.ts'],
            thresholds: {
                statements: 70,
                branches: 70,
                functions: 70,
                lines: 70,
            },
        },
    },
});
