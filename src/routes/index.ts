import { Router } from 'express';
import rootRoute from './root.route';
import apiRoute from './api.route';

const routes: Record<string, Router> = {
    '/': rootRoute,
    '/api/v1': apiRoute,
};
export default routes;
