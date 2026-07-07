import { createClient } from 'redis';
import { createLogger } from './logger';

const logger = createLogger('redis');

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD || '', // docker 启动时的 --requirepass
    socket: {
        connectTimeout: 3000, // 连接超时 3 秒
        // keepAlive: 10000, // 开启 TCP KeepAlive，防止冷连接
    },
    pingInterval: 10000,
});

redisClient.on('error', (error) =>
    logger.error('Redis Client Error', { error }),
);
redisClient.on('connect', () => logger.info('Connected to Redis'));

// 确保在应用启动时连接
(async () => {
    await redisClient.connect();
})();

export default redisClient;
