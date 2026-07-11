import { Request, Response, NextFunction } from 'express';
import ApiResponse from '@/utils/apiResponse';
import { COOKIE_TOKEN_MAX_AGE, UNKNOWN_ERROR } from '@/utils/constant';
import Joi from 'joi';
import authService from '../services/auth.service';

const registerSchema = Joi.object({
    username: Joi.string().min(3).max(30).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required(),
});

const setTokenCookie = (res: Response, token: string) => {
    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: COOKIE_TOKEN_MAX_AGE,
        path: '/', // 确保 cookie 在整个站点范围内可用
    });
};

export const register = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { error, value } = registerSchema.validate(req.body);
        if (error) {
            return res
                .status(400)
                .json(
                    new ApiResponse(false, null, error?.details?.[0]?.message),
                );
        }
        const result = await authService.register(
            value.username,
            value.email,
            value.password,
        );
        setTokenCookie(res, result.token); // 将 token 设置为 cookie
        res.json(ApiResponse.success(null, '注册成功'));
    } catch (err) {
        console.error('Registration error:', err); // 添加日志输出错误信息
        res.status(500).json(
            new ApiResponse(
                false,
                null,
                err instanceof Error ? err.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export const login = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res
                .status(400)
                .json(new ApiResponse(false, null, '用户名和密码不能为空'));
        }
        const token = await authService.login(username, password);
        setTokenCookie(res, token); // 将 token 设置为 cookie
        res.json(ApiResponse.success(null, '登录成功'));
    } catch (err) {
        res.status(500).json(
            ApiResponse.error(
                err instanceof Error ? err.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export default {
    register,
    login,
};
