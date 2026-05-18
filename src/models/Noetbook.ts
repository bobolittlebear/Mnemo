import mongoose from "mongoose";
import { timeStamp } from "node:console";

const notebookSchema = new mongoose.Schema({
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
    timeStamp: {
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
    },
}, {
    timestamps: true,
});

export default mongoose.model("Notebook", notebookSchema);