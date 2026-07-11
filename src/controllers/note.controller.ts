import { Request, Response, NextFunction } from 'express';
import noteService from '../services/note.service';
import ApiResponse from '@/utils/apiResponse';
import { UNKNOWN_ERROR } from '@/utils/constant';

const createNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { title, content, user, notebookId } = req.body;
        const note = await noteService.createNote(
            notebookId,
            title,
            content,
            user,
        );
        res.json(ApiResponse.success(note));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const getNotes = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { notebookId, user, page = 1, limit = 20 } = req.query;
        const notes = await noteService.getNotes(
            String(notebookId),
            String(user),
            Number(page),
            Number(limit),
        );
        res.json(ApiResponse.success(notes));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const getNoteById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const { user } = req.query;
        const note = await noteService.getNoteById(String(id), String(user));
        res.json(ApiResponse.success(note));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const updateNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const { title, content, user } = req.body;
        const note = await noteService.updateNote(
            String(id),
            String(user),
            title,
            content,
        );
        res.json(ApiResponse.success(note));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

const deleteNote = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const { user } = req.query;
        const note = await noteService.deleteNote(String(id), String(user));
        res.json(ApiResponse.success(note));
    } catch (error) {
        res.json(
            ApiResponse.error(
                error instanceof Error ? error.message : UNKNOWN_ERROR,
            ),
        );
    }
};

export default {
    createNote,
    getNotes,
    getNoteById,
    updateNote,
    deleteNote,
};
