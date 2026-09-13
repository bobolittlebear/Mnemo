import mongoose from 'mongoose';

/** 连接串导出，供测试复用，避免默认值散落多处 */
export const MONGODB_URI =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';

/**
 * 默认连接选项。
 *
 * `maxIdleTimeMS` 让 driver 主动回收空闲连接：Atlas 约 30min 空闲即静默断链，
 * 等对端先动手时本地 monitor 已经超时，driver 会把整个连接池清空（pool cleared），
 * 下一个查询直接失败。60s 远小于该窗口，把「谁先断」的主动权拿回本地。
 *
 * `bufferCommands: false` 保持不变：连接不可用时立即抛错而非静默缓冲，
 * 后台任务据此把连接故障当成瞬态失败，由重试层（`withRetry` + driver 自愈）
 * 兜住，不再单独做开工前的连接探针。
 */
export const DB_CONNECT_OPTIONS: mongoose.ConnectOptions = {
    bufferCommands: false,
    autoIndex: false,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 30_000,
};

const connectDB = async () => {
    try {
        await mongoose.connect(MONGODB_URI, DB_CONNECT_OPTIONS);
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
};

export default connectDB;
