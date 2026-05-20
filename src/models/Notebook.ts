import mongoose from 'mongoose';

const notebookSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        createUser: {
            type: String,
            required: true,
        },
        updateUser: {
            type: String,
            required: true,
        },
        // 软删除标志
        isDeleted: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    },
);

export default mongoose.model('Notebook', notebookSchema);
