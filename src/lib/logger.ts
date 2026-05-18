import morgan from "morgan";
import winston from "winston";
import type { Logger } from "winston";

// 配置winston日志器
const logger: Logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({
      filename: "run_logs/error.log",
      level: "error",
    }), // 错误日志
    new winston.transports.File({ filename: "run_logs/combined.log" }), // 所有日志

    // 控制台管道
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

export default logger;
