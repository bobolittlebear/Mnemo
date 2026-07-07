import winston from 'winston';
import type { Logger as WinstonLogger } from 'winston';
import { AsyncLocalStorage } from 'node:async_hooks';

// ============================================================
// 模块标签
// ============================================================

export type ModuleTag =
    | 'api'
    | 'auth'
    | 'ai'
    | 'agent'
    | 'stm'
    | 'ltm'
    | 'rag'
    | 'redis'
    | 'mongodb'
    | 'code';

// ============================================================
// 日志上下文
// ============================================================

export interface LogContext {
    requestId?: string;
    component?: string; // 底层依赖标注，如 ltm 模块标 component: "redis"
    duration_ms?: number;
    error?: Error; // Error 对象，winston 自动展开 message + stack
    [key: string]: unknown;
}

// ============================================================
// RequestId — AsyncLocalStorage 存储，format 层自动注入
// ============================================================

const requestIdStore = new AsyncLocalStorage<string>();

/**
 * 在中间件中调用，将 requestId 写入当前异步上下文，
 * 后续所有 logger 输出自动携带。
 *
 * 用法（trace.middleware.ts）:
 *   import { runWithRequestId } from "@/lib/logger";
 *   export function traceMiddleware(req, res, next) {
 *     runWithRequestId(req.id, next);
 *   }
 */
export function runWithRequestId(requestId: string, fn: () => void): void {
    requestIdStore.run(requestId, fn);
}

/** 获取当前异步上下文的 requestId，供 format 内部使用 */
export function getRequestId(): string | undefined {
    return requestIdStore.getStore();
}

// ============================================================
// 自定义 Winston Format（root logger 专用）
// ============================================================

/** 自动注入 requestId 到每条日志 */
const injectRequestId = winston.format((info) => {
    const rid = requestIdStore.getStore();
    if (rid && !info.requestId) {
        info.requestId = rid;
    }
    return info;
})();

/**
 * 在 colorize 之前把 level 转大写。
 *
 * 不能在 printf 里 toUpperCase —— colorize 会给 level 加 ANSI 颜色码
 * (如 \x1b[31merror\x1b[39m)，toUpperCase 会把 SGR 终止符 m 变成 M，
 * 破坏 ANSI 序列，终端会吃掉部分字符。
 *
 * 正确顺序：upperLevel → colorize → printf
 *   upperLevel:  "error" → "ERROR"
 *   colorize:    "ERROR" → "\x1b[31mERROR\x1b[39m"
 *   printf:      直接用，不再转换
 */
const upperLevel = winston.format((info) => {
    info.level = String(info.level || '').toUpperCase();
    return info;
})();

/**
 * 终端输出格式:
 *   [2026-07-07 15:30:00.123] [ERROR] [redis] [req-abc123] 消息 {"key":"value"}
 *
 * 文件输出格式: JSON（由 transport 单独配置，方便日志平台采集）
 */
const consoleFormat = winston.format.printf(
    ({
        timestamp,
        level,
        module,
        requestId,
        message,
        error,
        stack,
        duration_ms,
        component,
        ...rest
    }) => {
        const ts = timestamp || '';
        const mod = module ? `[${module}]` : '';
        const rid = requestId ? `[${requestId}]` : '';

        // 收集 context 字段
        const context: Record<string, unknown> = {};
        if (duration_ms !== undefined) context.duration_ms = duration_ms;
        if (component) context.component = component;
        Object.assign(context, rest);

        // error 对象优先展示 message，stack 追加到末尾
        let msg = message as string;
        if (error && typeof error === 'object' && 'message' in error) {
            context.error = error.message;
            // level 已被 colorize，用 includes 判断原始级别
            const levelStr = String(level);
            if (
                (error as Error).stack &&
                (levelStr.includes('ERROR') || levelStr.includes('WARN'))
            ) {
                msg += `\n${(error as Error).stack}`;
            }
        }

        const ctx =
            Object.keys(context).length > 0 ? JSON.stringify(context) : '';
        // 紧凑格式: [timestamp] [LEVEL] [module] [requestId] message {context}
        return [ts && `[${ts}]`, `[${level}]`, mod, rid, msg + ctx]
            .filter(Boolean)
            .join(' ');
    },
);

// ============================================================
// Root Logger — 全局唯一，transports 只配置一次
// ============================================================

const LOG_LEVEL =
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const rootLogger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        injectRequestId,
        winston.format.errors({ stack: true }),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    ),
    transports: [
        // TODO1: 替换为 winston-daily-rotate-file
        // 当前使用 winston.transports.File，日志文件会无限增长。生产环境中这会导致磁盘爆满。

        // 错误日志 — 单独文件
        new winston.transports.File({
            filename: 'run_logs/error.log',
            level: 'error',
            format: winston.format.json(),
        }),
        // 全量日志
        new winston.transports.File({
            filename: 'run_logs/combined.log',
            format: winston.format.json(),
        }),
        // 控制台 — 可读格式
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                upperLevel,
                winston.format.colorize(),
                consoleFormat,
            ),
        }),
    ],
});

// ============================================================
// 模块 Logger 工厂 — child logger 共享 root 的 transports
// ============================================================

const loggerCache = new Map<ModuleTag, WinstonLogger>();

/**
 * 创建（或复用）指定模块的 child logger。
 *
 * child logger 共享 root logger 的 transports 和 format，
 * 只额外注入 module 字段，不会重复打开文件句柄。
 *
 * 用法:
 *   const log = createLogger("stm");
 *   log.info("Message appended", { sessionId, rounds: 5 });
 *   log.error("Session creation failed", { sessionId, error: err });
 *
 * 按模块单独控制级别（未来扩展）:
 *   const log = createLogger("redis");
 *   log.level = "error";  // 只看 redis 的 error
 */
export function createLogger(module: ModuleTag): WinstonLogger {
    const cached = loggerCache.get(module);
    if (cached) return cached;

    const child = rootLogger.child({ module });
    loggerCache.set(module, child);
    return child;
}

// TODO2: 日志脱敏, 如用户认证或 API Key 处理等
