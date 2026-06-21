import { Request, Response, Router } from 'express';
import logger from '../lib/logger';
import {} from 'express';

const router: Router = Router();
/* GET home page. */
router.get('/', function (req: Request, res: Response) {
    logger.info('首页被访问', { ip: req.ip });
    res.render('index', { title: 'Express' });
});

export default router;
