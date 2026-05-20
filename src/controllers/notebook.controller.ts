import { Request, Response, NextFunction } from 'express';
import notebookService from '../service/notebook.service';
import ApiResponse from '../util/ApiResponse';
import { UNKNOWN_ERROR } from '../util/constant';

export const createNotebook = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const { title, user } = req.body;
        const notebook = await notebookService.createNotebook(user, title);
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
        const { user, page = 1, limit = 20 } = req.query;
        const notebooks = await notebookService.getNotebooks(
            String(user),
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
        const { user } = req.query;
        const notebook = await notebookService.getNotebookById(
            String(id),
            String(user),
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
        const { title, user } = req.body;
        const notebook = await notebookService.updateNotebook(
            String(id),
            String(user),
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
        const { user } = req.query;
        const notebook = await notebookService.deleteNotebook(
            String(id),
            String(user),
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
