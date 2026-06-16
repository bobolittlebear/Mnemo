import jwt from 'jsonwebtoken';
import { RENEW_THRESHOLD } from './constant';

// 生产环境用环境变量
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

export const generateToken = (userId: string) => {
    return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1w' });
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
