import jwt from 'jsonwebtoken';
import { RENEW_THRESHOLD } from './constant';

// 生产环境用环境变量
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

export const generateToken = (userId: string) => {
    // 改成一个月过期
    return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '30d' });
};

export const verifyToken = (token: string) => {
    try {
        return jwt.verify(token, JWT_SECRET, { complete: true }).payload as {
            id: string;
            iat: number;
            exp: number;
        };
    } catch (err) {
        return null;
    }
};

export const isTokenExpiringSoon = (expTime: number) => {
    return expTime - Date.now() < RENEW_THRESHOLD;
};
