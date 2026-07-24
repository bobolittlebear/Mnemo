/**
 * 长期记忆触发器模块统一 Redis Key 定义。
 * 所有 trigger 组件与对应测试均从本文件取 key，禁止在各自文件硬编码前缀。
 * ⚠️ key 字符串格式一经使用即与线上 Redis 数据绑定，禁止修改已有字段名/分隔符。
 */
export interface SessionTriggerKeys {
    lock: string;
    extracted: string;
    processing: string;
    msgCount: string;
    lastActiveAt: string;
}

export function sessionTriggerKeys(sessionId: string): SessionTriggerKeys {
    return {
        lock: `memory:session:${sessionId}:lock`,
        extracted: `memory:session:${sessionId}:extracted`,
        processing: `memory:session:${sessionId}:processing`,
        msgCount: `memory:session:${sessionId}:msg_count`,
        lastActiveAt: `memory:session:${sessionId}:last_active_at`,
    };
}
