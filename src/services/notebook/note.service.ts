import NoteModel from '@/models/Note';
import type { Note } from '@/types/models';
import type { HydratedDocument } from 'mongoose';
import { createLogger } from '@/lib/logger';
import { markNoteDirty, removeNoteIndex } from './noteReindex.service';

const log = createLogger('rag');

// Note 接口是纯类型且未声明 timestamps，本地用 HydratedDocument 补齐 _id/__v 与时间戳字段
// （createUser/updateUser 存的是 userId）
type NoteDoc = HydratedDocument<Note> & { createdAt: Date; updatedAt: Date };

// 私有 DTO 映射：Mongoose document → 纯对象，_id 归一化为 id，notebookId 转为 string
const toNoteDTO = (doc: NoteDoc) => ({
    id: doc._id.toString(),
    notebookId: String(doc.notebookId),
    title: doc.title,
    content: doc.content,
    createUser: doc.createUser,
    updateUser: doc.updateUser,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
});

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
    const saved = await note.save();
    if (saved?._id?.toString) {
        // RAG 增量重建脏标记（fire-and-forget，不阻塞响应）
        markNoteDirty(saved._id.toString());
    }
    return toNoteDTO(saved as NoteDoc);
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

    return notes.map((note) => toNoteDTO(note as NoteDoc));
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
    return toNoteDTO(note as NoteDoc);
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
    if (note?._id?.toString) {
        // RAG 增量重建脏标记（fire-and-forget，不阻塞响应）
        markNoteDirty(note._id.toString());
    }
    return toNoteDTO(note as NoteDoc);
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
    // 软删 Note 后硬删派生 chunk + 清理脏标记（fire-and-forget，不阻塞删除响应）
    removeNoteIndex(noteId).catch((error) => {
        log.error('删除笔记后清理 RAG 索引失败', error as Error, { noteId });
    });
    return toNoteDTO(note as NoteDoc);
};

export default {
    createNote,
    getNotes,
    getNoteById,
    updateNote,
    deleteNote,
};
