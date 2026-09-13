/**
 * db/index 单元测试
 *
 * 测试目标：连接选项调优（maxIdleTimeMS 必须显著小于 Atlas 空闲回收窗口）、
 *           connectDB 启动期使用的连接参数、模块导出契约
 * Mock 依赖：mongoose（connect / connection.readyState）—— 不连真实 DB
 * 真实逻辑：连接选项常量、启动期连接入口的参数组装
 *
 * 注：ensureConnected 已移除——连接故障不再由后台任务开工前探针处理，改为
 * 首个查询抛错后交给 withRetry + driver 自愈。故本文件只保留「模块不再导出
 * 该函数」的回归 guard，不测其行为。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockConnect, mockConnection, mockConsoleLog, mockConsoleError } =
    vi.hoisted(() => ({
        mockConnect: vi.fn(),
        mockConnection: { readyState: 0 },
        mockConsoleLog: vi.fn(),
        mockConsoleError: vi.fn(),
    }));

vi.mock('mongoose', () => ({
    default: {
        connection: mockConnection,
        connect: mockConnect,
        STATES: {
            disconnected: 0,
            connected: 1,
            connecting: 2,
            disconnecting: 3,
        },
    },
}));

import connectDB, { DB_CONNECT_OPTIONS, MONGODB_URI } from '@/db';
import * as dbModule from '@/db';

/** Atlas 空闲回收窗口约 30min：本地回收必须远早于它，否则会被对端先断链、清空连接池 */
const ATLAS_IDLE_REAP_MS = 30 * 60_000;

beforeEach(() => {
    vi.clearAllMocks();
    mockConnection.readyState = 0; // 默认未连接
    mockConnect.mockResolvedValue(undefined);
});

describe('DB_CONNECT_OPTIONS', () => {
    it('空闲回收窗口显著小于 Atlas 的 30min', () => {
        expect(DB_CONNECT_OPTIONS.maxIdleTimeMS).toBe(60_000);
        expect(DB_CONNECT_OPTIONS.maxIdleTimeMS!).toBeLessThan(
            ATLAS_IDLE_REAP_MS / 4,
        );
    });

    it('保留 bufferCommands:false 与 autoIndex:false，并设置 serverSelectionTimeoutMS', () => {
        expect(DB_CONNECT_OPTIONS.bufferCommands).toBe(false);
        expect(DB_CONNECT_OPTIONS.autoIndex).toBe(false);
        expect(DB_CONNECT_OPTIONS.serverSelectionTimeoutMS).toBe(30_000);
    });
});

describe('connectDB（启动期连接）', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
        errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(mockConsoleError);
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('用同一套 MONGODB_URI + DB_CONNECT_OPTIONS 发起连接', async () => {
        await connectDB();

        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(mockConnect).toHaveBeenCalledWith(
            MONGODB_URI,
            DB_CONNECT_OPTIONS,
        );
        expect(mockConsoleLog).toHaveBeenCalledWith(
            'MongoDB connected successfully',
        );
    });

    it('连接失败只记录不抛出（启动期不因首次连接失败而崩进程）', async () => {
        const err = new Error('server selection timeout');
        mockConnect.mockRejectedValue(err);

        await expect(connectDB()).resolves.toBeUndefined();

        expect(mockConsoleError).toHaveBeenCalledWith(
            'MongoDB connection error:',
            err,
        );
    });
});

describe('模块导出契约', () => {
    it('仍导出 MONGODB_URI / DB_CONNECT_OPTIONS 与默认 connectDB', () => {
        expect(typeof connectDB).toBe('function');
        expect(MONGODB_URI).toMatch(/^mongodb(\+srv)?:\/\//);
        expect(DB_CONNECT_OPTIONS).toBeTypeOf('object');
    });

    it('不再导出 ensureConnected（连接探针已移除）', () => {
        expect('ensureConnected' in dbModule).toBe(false);
    });
});
