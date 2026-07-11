## 🚀 快速开始

### 1. 启动 Redis

```bash
docker run -d \
  --name mnemo-redis \
  -p 6379:6379 \
  -v 你的redis目录:/data \
  --restart always \
  redis:8.6-alpine \
  redis-server --requirepass mnemo
```

### 2. 启动 Node 服务

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm run dev

# 构建生产版本
pnpm run build

# 启动生产服务器
pnpm start
```

### 环境变量说明

| 变量名           | 说明                               |
| ---------------- | ---------------------------------- |
| `MONGODB_URI`    | MongoDB 连接地址                   |
| `JWT_SECRET`     | JWT 签名密钥                       |
| `AI_BASE_URL`    | AI 服务基础地址（OpenAI 兼容接口） |
| `AI_API_KEY`     | AI 服务 API Key                    |
| `AI_MODEL`       | 默认对话模型                       |
| `AI_MODEL_2`     | 备用模型（如记忆提取、RAG 等场景） |
| `REDIS_URL`      | Redis 连接地址                     |
| `REDIS_PASSWORD` | Redis 密码                         |
| `STM_ROUNDS`     | 短期记忆保留的对话轮数             |

---

## 🧪 测试

项目使用 Vitest 作为测试框架，分为单元测试和集成测试两层。

### 测试目录结构

单元测试目录镜像 `src/` 结构，集成测试在 `integration/` 内同样镜像 `src/`。新增测试时按源码路径找对应位置即可。

```
tests/
├── helpers/                                # 共享测试工具
│   ├── fixtures.ts                         # 测试数据工厂
│   └── mockFactory.ts                      # Mock 工厂
├── services/                               # 单元测试（镜像 src/，全 Mock）
│   └── memory/
│       ├── memoryExtraction.service.test.ts  # ← src/services/memory/memoryExtraction.service.ts
│       ├── memoryIngestion.service.test.ts   # ← src/services/memory/memoryIngestion.service.ts
│       └── memoryPipeline.service.test.ts    # ← src/services/memory/memoryPipeline.service.ts
├── integration/                            # 集成测试（真实 MongoDB + Redis，Mock LLM）
│   └── services/
│       └── memory/
│           └── memoryPipeline.integration.test.ts
└── setup.ts                                # 全局 setup
```

**新增测试的对照规则**：`src/xxx/yyy.ts` → `tests/xxx/yyy.test.ts`（单元）/ `tests/integration/xxx/yyy.test.ts`（集成）

### 运行测试

```bash
# 运行全部测试
pnpm test

# 仅运行单元测试（无需外部依赖，< 1 秒）
pnpm test:unit

# 仅运行集成测试（需要本地 MongoDB + Redis）
pnpm test:integration

# 监听模式（开发时自动重跑）
pnpm test:watch

# 生成覆盖率报告
pnpm test:coverage
```

### 集成测试前提条件

集成测试使用真实 MongoDB 和 Redis，Mock LLM 和 Embedding 调用。运行前需确保：

1. **Redis 已启动**

   ```bash
   docker run -d --name mnemo-redis -p 6379:6379 redis:8.6-alpine redis-server --requirepass mnemo
   ```

2. **MongoDB 已启动**

   ```bash
   docker run -d --name mnemo-mongo -p 27017:27017 mongo:5.0
   ```

### 测试覆盖范围

| 类型 | 用例数 | 依赖            |
| ---- | ------  | --------------- |
| 单元 | 33      | 全 Mock         |
| 集成 | 5       | 真实 DB + Redis |

### Mock 策略

- **单元测试**：`vi.mock('@/...')` 拦截所有外部依赖（LLM、MongoDB、Redis、Embedding），只测业务逻辑
- **集成测试**：Mock LLM + Embedding（太慢），保留真实 MongoDB + Redis（验证落盘 + 标记）
- **Mock 路径用 `@/` 别名**，与源码 import 路径完全一致，避免相对路径层级问题

### 测试规则

| #   | 规则                                                       | 说明                                                                       |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | 单元测试与集成测试严格分离                                 | 目录分开（`tests/services/` vs `tests/integration/`），运行命令独立       |
| 2   | AI 接口必须完整 mock，禁止真实调用，且断言请求参数         | 不仅验证"被调了"，还要验证"参数对不对"（role、content、temperature 等）   |
| 3   | 单元测试禁止任何 IO 操作                                   | 所有外部依赖（DB、Redis、HTTP）用 `vi.mock` 拦截，只测纯业务逻辑          |
| 4   | 每个测试独立                                               | `afterEach` / `beforeEach` 清理 mock 状态和测试数据，用例间零依赖         |
| 5   | 使用强断言，禁止 `toBeDefined` / `toBeTruthy`              | 断言精确值（`toBe`）、精确类型（`toBe(true)`）、精确格式（`toMatch`）     |
| 6   | 每个被测函数覆盖 happy path + 至少 2 个 edge case + 错误处理 | happy path 验证主流程，edge case 验证边界，错误处理验证异常传播和副作用  |
