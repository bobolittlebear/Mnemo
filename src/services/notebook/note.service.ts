import NoteModel from '@/models/Note';

const createNote = async (
    notebookId: string,
    title: string,
    content: string,
    user: string,
) => {
    const note = new NoteModel({
        notebookId,
        title,
        content,
        createUser: user,
        updateUser: user,
    });
    await note.save();
    return note;
};

const getNotes = async (
    notebookId: string,
    user: string,
    page: number,
    limit: number,
) => {
    const skip = (page - 1) * limit;
    const notes = await NoteModel.find({
        notebookId,
        isDeleted: false,
        createUser: user,
    })
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 }) // 按创建时间倒序排列
        .select('-isDeleted'); // 不返回软删除标志;

    return notes;
};

const getNoteById = async (noteId: string, user: string) => {
    const note = await NoteModel.findOne({
        _id: noteId,
        isDeleted: false,
        createUser: user,
    });
    if (!note) {
        throw new Error('笔记不存在');
    }
    return note;
};

const updateNote = async (
    noteId: string,
    user: string,
    title: string,
    content: string,
) => {
    const note = await NoteModel.findOneAndUpdate(
        { _id: noteId, isDeleted: false, createUser: user },
        { title, content, updateUser: user },
        { new: true }, // 返回更新后的数据
    );
    if (!note) {
        throw new Error('笔记不存在或无权更新');
    }
    return note;
};

const deleteNote = async (noteId: string, user: string) => {
    const note = await NoteModel.findOneAndUpdate(
        { _id: noteId, isDeleted: false, createUser: user },
        { isDeleted: true, updateUser: user },
        { new: true }, // 返回更新后的数据
    );
    if (!note) {
        throw new Error('笔记不存在或无权删除');
    }
    return note;
};

export default {
    createNote,
    getNotes,
    getNoteById,
    updateNote,
    deleteNote,
};
