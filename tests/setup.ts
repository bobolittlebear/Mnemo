/**
 * 全局测试 setup
 *
 * 在 vitest.config.ts 的 setupFiles 中引用
 * 每个 test 文件执行前自动运行
 */
import { afterEach, vi } from 'vitest';

// 每个测试结束后自动清理 Mock，防止用例间污染
afterEach(() => {
    vi.clearAllMocks();
});

/**
 * 抑制测试中的 console.error 噪音
 * 如果需要调试某个用例的 console 输出，注释掉这段
 */
// vi.spyOn(console, 'error').mockImplementation(() => {});
// vi.spyOn(console, 'warn').mockImplementation(() => {});
