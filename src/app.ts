import createError from "http-errors";
import express, { Request, Response, NextFunction} from "express";
import path from "path";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import logger from "./lib/logger";
import indexRouter from "./routes"
import connectDB from "./db";

const app = express();

// 连接数据库
connectDB();

// winston 集成到 morgan 中
// morgan 的日志也会通过 winston 写入文件
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// view engine setup
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");

// app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));


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
  res.locals.error = req.app.get("env") === "development" ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render("error");
});

app.listen(3000);

export default app;
