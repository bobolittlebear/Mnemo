# Claude Code Project Rules

## 优先级原则

1. 先理解项目结构，再修改代码
2. 保持现有架构分层，不要把业务逻辑散落到入口文件
3. 优先复用现有 service / middleware / util 逻辑
4. 修改聊天、记忆、认证相关逻辑时，必须考虑兼容性和降级处理

## 代码风格

- 使用 TypeScript，保持类型清晰
- 继续使用当前项目中的命名和注释风格
- 采用 Prettier / ESLint 的现有约定
- 尽量避免引入大范围重构

## 变更注意事项

- 新接口优先走 route -> controller -> service -> model
- 流式响应必须保持 SSE 兼容
- Redis / MongoDB 改动要考虑异常情况和默认值
- 任何改动都应该尽量保持现有 API 响应格式一致
