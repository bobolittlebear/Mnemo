// 必须是文件的第一行代码
import 'module-alias/register';
import dotenv from 'dotenv';
dotenv.config({
    path: `.env.${process.env.NODE_ENV || 'development'}`,
});

import createError from 'http-errors';
import express, { Request, Response, NextFunction, Application } from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import cors from 'cors';
import logger from './lib/logger';
import indexRouter from './routes';
import connectDB from './db';

const app: Application = express();

// 允许跨域请求
app.use(
    cors({
        origin: 'http://localhost:3000', // 允许来自这个源的请求,或者设置为前端服务端口
        credentials: true, // 允许携带 cookie
    }),
);

// 连接数据库
connectDB();

// winston 集成到 morgan 中
// morgan 的日志也会通过 winston 写入文件
app.use(
    morgan('combined', {
        stream: { write: (message) => logger.info(message.trim()) },
    }),
);

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// 使用路由
Object.entries(indexRouter).forEach(([path, router]) => {
    app.use(path, router);
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    next(createError(404));
});

// error handler
app.use(function (err: any, req: Request, res: Response, next: NextFunction) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    // render the error page
    console.error(err.stack); // 在控制台打印详细错误，方便调试
    res.status(err.status || 500).json({
        status: 'error',
        message: err.message,
        // stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

app.listen(3000);

export default app;
