import { Request, Response, Router } from 'express';
import {} from 'express';

const router: Router = Router();
/* GET home page. */
router.get('/', function (req: Request, res: Response) {
    res.render('index', { title: 'Express' });
});

export default router;
