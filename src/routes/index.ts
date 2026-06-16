import { Router } from 'express';
import rootRoute from './root.route';
import apiRoute from './api.route';
import authRoute from './auth.route';
import chatRoute from './chat.route';

const routes: Record<string, Router> = {
    '/': rootRoute,
    '/auth': authRoute,
    '/api/v1': apiRoute,
    '/stream': chatRoute,
};
export default routes;
