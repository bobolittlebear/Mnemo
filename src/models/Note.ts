import mongoose from "mongoose";

const noteSchema = new mongoose.Schema({
    notebookId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Notebook",
        required: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    content: {
        type: String,
        default: "",
    },
    createUser: {
        type: String,
        required: true,
    },
    updateUser: {
        type: String,
        required: true,
    },
}, {
    timestamps: true,
});

export default mongoose.model("Note", noteSchema);