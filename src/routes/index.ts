import rootRoute from './root.route';
import { Router } from 'express';

const routes: Record<string, Router> = {
    '/': rootRoute,
};
export default routes;
