# f2b-sandbox

灵境云 **AI 沙箱** 产品微服务：生命周期 · 命令 · 文件 · Fake/生产数据面 adapter。

## 快速开始

```bash
# 同级目录需有 f2b-spec（file: 依赖）
cd ../f2b-spec && pnpm install
cd ../f2b-sandbox && pnpm install
pnpm migrate   # 或启动时自动建表
F2B_SANDBOX_BACKEND=fake pnpm dev
```

默认监听 `http://0.0.0.0:8787`。

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s -X POST http://127.0.0.1:8787/v1/sandboxes \
  -H 'content-type: application/json' \
  -d '{"template":"base"}'
```

冒烟（需服务已启动）：

```bash
pnpm smoke
```

## API

见 [f2b-spec `openapi/sandbox-v1.yaml`](https://github.com/f2b-dev/f2b-spec/blob/main/openapi/sandbox-v1.yaml)。

| 方法 | 路径 |
|------|------|
| GET/POST | `/v1/sandboxes` |
| GET/DELETE | `/v1/sandboxes/:id` |
| POST | `/v1/sandboxes/:id/commands` |
| GET/POST | `/v1/sandboxes/:id/files` |

## 环境变量

见 [`.env.example`](./.env.example)。数据面管理密钥 **仅服务端**。

## 相关

- 契约：https://github.com/f2b-dev/f2b-spec  
- 组织：https://github.com/f2b-dev  
