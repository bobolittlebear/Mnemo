import UserModel from '../models/User';
import { generateToken } from '../util/jwt';

export const register = async (
    username: string,
    email: string,
    password: string,
) => {
    const existingUser = await UserModel.findOne({
        $or: [{ email }, { username }],
    });
    if (existingUser) {
        throw new Error('用户名或邮箱已存在');
    }
    const user = new UserModel({ username, email, password });
    await user.save();
    const token = generateToken(user._id.toString());
    return { user, token };
};

export const login = async (username: string, password: string) => {
    const user = await UserModel.findOne({ username });
    if (!user) {
        throw new Error('用户不存在');
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw new Error('用户名或密码错误');
    }
    return generateToken(user._id.toString());
};

export default {
    register,
    login,
};
