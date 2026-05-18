import express, { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';
const router = express.Router();

/* GET home page. */
router.get('/', function (req: Request, res: Response) {
    logger.info('首页被访问', { ip: req.ip });
    res.render('index', { title: 'Express' });
});

export default router;
