import { Request, Response, NextFunction } from 'express';
import ApiResponse from '@/utils/apiResponse';
import { COOKIE_TOKEN_MAX_AGE } from '@/utils/constant';
import { generateToken, isTokenExpiringSoon, verifyToken } from '@/utils/jwt';

// 扩展Express的Request类型，添加userId属性
declare global {
    namespace Express {
        interface Request {
            user: {
                userId?: string;
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

        // 令牌即将过期时直接续期：把新 token 写回 httpOnly cookie（与 auth.controller 的 cookie 选项一致）。
        // 不能只设响应头——httpOnly cookie 前端无法读取也无法回写，续期必须由服务端写 cookie 完成
        if (isTokenExpiringSoon(decoded.exp * 1000)) {
            const newToken = generateToken(decoded.id);
            res.cookie('token', newToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: COOKIE_TOKEN_MAX_AGE,
                path: '/',
            });
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
