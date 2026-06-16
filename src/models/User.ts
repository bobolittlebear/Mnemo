import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends mongoose.Document {
    username: string;
    password: string;
    email: string;
    comparePassword(candidatePassword: string): Promise<boolean>;
}
const userSchema = new mongoose.Schema<IUser>(
    {
        username: {
            type: String,
            required: true,
            trim: true,
        },
        password: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
    },
    {
        timestamps: true, // 自动添加 createdAt 和 updatedAt 字段
    },
);

userSchema.pre('save', async function (next) {
    const user = this;
    if (!user.isModified('password')) {
        return next();
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(user.password, salt);
    next();
});

userSchema.methods.comparePassword = async function (
    candidatePassword: string,
) {
    return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('User', userSchema);
