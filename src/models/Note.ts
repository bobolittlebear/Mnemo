import mongoose from 'mongoose';
import type { INote } from '@/types/models';

const noteSchema = new mongoose.Schema<INote>(
    {
        notebookId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Notebook',
            required: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        content: {
            type: String,
            default: '',
        },
        createUser: {
            type: String,
            required: true,
        },
        updateUser: {
            type: String,
            required: true,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    },
);

export default mongoose.model('Note', noteSchema);
