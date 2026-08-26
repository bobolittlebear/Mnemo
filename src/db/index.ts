import mongoose from 'mongoose';
const MONGODB_URI =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/express-service';

const connectDB = async () => {
    try {
        await mongoose.connect(MONGODB_URI, {
            bufferCommands: false,
            autoIndex: false,
        });
        console.log('MongoDB connected successfully');

        const isDev = process.env.NODE_ENV === 'development';
        // 开发环境下额外做一次 sync，清理历史遗留索引
        if (isDev) {
            const MemoryFact = mongoose.model('MemoryFact');
            const dropped = await MemoryFact.syncIndexes();
            if (dropped.length > 0) {
                console.log(`[dev] Cleaned stale indexes: ${dropped}`);
            }
        }
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
};

export default connectDB;
