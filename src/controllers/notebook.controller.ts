import { Request, Response, NextFunction } from 'express';
import notebookService from '@/services/notebook/notebook.service';
import ApiResponse from '@/utils/apiResponse';
import { UNKNOWN_ERROR } from '@/utils/constant';

export const createNotebook = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { title } = req.body;
        const notebook = await notebookService.createNotebook(
            req.user.userId!,
            title,
        );
        res.json(ApiResponse.success(notebook));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export const getNotebooks = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const notebooks = await notebookService.getNotebooks(
            req.user.userId!,
            Number(page),
            Number(limit),
        );
        res.json(ApiResponse.success(notebooks));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const getNotebookById = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { id } = req.params;
        const notebook = await notebookService.getNotebookById(
            String(id),
            req.user.userId!,
        );
        res.json(ApiResponse.success(notebook));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const updateNotebook = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { id } = req.params;
        const { title } = req.body;
        const notebook = await notebookService.updateNotebook(
            String(id),
            req.user.userId!,
            title,
        );
        res.json(ApiResponse.success(notebook));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const deleteNotebook = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { id } = req.params;
        const notebook = await notebookService.deleteNotebook(
            String(id),
            req.user.userId!,
        );
        res.json(ApiResponse.success(notebook));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export default {
    createNotebook,
    getNotebooks,
    getNotebookById,
    updateNotebook,
    deleteNotebook,
};
