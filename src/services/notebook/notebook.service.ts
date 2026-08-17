import NotebookModel from '@/models/Notebook';
import type { Notebook } from '@/types/models';
import type { HydratedDocument } from 'mongoose';

// Notebook 接口未声明 timestamps 字段，这里本地补齐（createUser/updateUser 存的是 userId）
type NotebookDoc = HydratedDocument<Notebook> & { createdAt: Date; updatedAt: Date };

// 私有 DTO 映射：Mongoose document → 纯对象，_id 归一化为 id（不保留 _id）
const toNotebookDTO = (doc: NotebookDoc) => ({
    id: doc._id.toString(),
    title: doc.title,
    createUser: doc.createUser,
    updateUser: doc.updateUser,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
});

const createNotebook = async (user: string, title: string) => {
    // 防止同一用户重复创建同名笔记本
    const existingNotebook = await NotebookModel.findOne({
        title,
        createUser: user,
        isDeleted: false, // 只考虑未删除的笔记本
    });
    if (existingNotebook) {
        throw new Error('笔记本名称已存在');
    }
    const newNotebook = new NotebookModel({
        title,
        createUser: user,
        updateUser: user,
    });
    const saved = await newNotebook.save();
    return toNotebookDTO(saved as NotebookDoc);
};

// 获取用户的笔记本列表，支持分页
const getNotebooks = async (
    user: string,
    page: number = 1,
    limit: number = 20,
) => {
    const skip = (page - 1) * limit;
    const notebooks = await NotebookModel.find({
        createUser: user,
        isDeleted: false,
    })
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 }) // 按创建时间倒序排列
        .select('-isDeleted'); // 不返回软删除标志;

    return notebooks.map((notebook) => toNotebookDTO(notebook as NotebookDoc));
};

const getNotebookById = async (notebookId: string, user: string) => {
    const notebook = await NotebookModel.findOne({
        _id: notebookId,
        createUser: user,
        isDeleted: false,
    });
    if (!notebook) {
        throw new Error('笔记本不存在');
    }
    return toNotebookDTO(notebook as NotebookDoc);
};

const updateNotebook = async (
    notebookId: string,
    user: string,
    title: string,
) => {
    const notebook = await NotebookModel.findOneAndUpdate(
        { _id: notebookId, createUser: user, isDeleted: false },
        { title, updateUser: user },
        { new: true }, // 返回更新后的数据
    );
    if (!notebook) {
        throw new Error('笔记本不存在或无权更新');
    }
    return toNotebookDTO(notebook as NotebookDoc);
};

// 软删除笔记本
const deleteNotebook = async (notebookId: string, user: string) => {
    const notebook = await NotebookModel.findOneAndUpdate(
        { _id: notebookId, createUser: user, isDeleted: false },
        { isDeleted: true },
        { new: true },
    );
    if (!notebook) {
        throw new Error('笔记本不存在或无权更新');
    }
    return toNotebookDTO(notebook as NotebookDoc);
};

export default {
    createNotebook,
    getNotebooks,
    getNotebookById,
    updateNotebook,
    deleteNotebook,
};
