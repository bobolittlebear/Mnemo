import { Request, Response, NextFunction } from 'express';
import ApiResponse from '@/utils/apiResponse';
import { generateToken, isTokenExpiringSoon, verifyToken } from '@/utils/jwt';

// 扩展Express的Request类型，添加userId属性
declare global {
    namespace Express {
        interface Request {
            user: {
                userId?: string;
                memoryKey?: string;
            };
        }
    }
}

export const authMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const token = req.cookies.token || '';
        if (!token) {
            return res
                .status(401)
                .json(new ApiResponse(false, null, '未提供有效的认证令牌'));
        }
        const decoded = verifyToken(token);
        if (!decoded || typeof decoded === 'string') {
            return res
                .status(401)
                .json(new ApiResponse(false, null, '令牌失效，请重新登录'));
        }

        // 如果令牌即将过期，提示前端刷新令牌
        if (isTokenExpiringSoon(decoded.exp * 1000)) {
            const newToken = generateToken(req.user.userId!);
            res.setHeader('X-New-Token', newToken);
        }

        // 将解析出的用户信息挂在req.user上，供后续中间件和路由处理函数使用
        req.user = { userId: decoded.id };
        next();
    } catch (err) {
        res.status(500).json(
            new ApiResponse(
                false,
                null,
                err instanceof Error ? err.message : '服务器错误',
            ),
        );
    }
};
