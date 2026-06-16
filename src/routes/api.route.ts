import Express from 'express';
import notebookController from '../controllers/notebook.controller';
import noteController from '../controllers/note.controller';
import authController from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
const router = Express.Router();

router.use(authMiddleware); // 保护所有后续路由，必须先通过认证

router.post('/notebooks', notebookController.createNotebook);
router.get('/notebooks', notebookController.getNotebooks);
router.get('/notebooks/:id', notebookController.getNotebookById);
router.put('/notebooks/:id', notebookController.updateNotebook);
router.delete('/notebooks/:id', notebookController.deleteNotebook);

router.post('/notes', noteController.createNote);
router.get('/notes', noteController.getNotes);
router.get('/notes/:id', noteController.getNoteById);
router.put('/notes/:id', noteController.updateNote);
router.delete('/notes/:id', noteController.deleteNote);

export default router;
