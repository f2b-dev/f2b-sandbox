# f2b-sandbox

灵境云 **AI 沙箱** 产品微服务：生命周期 · 命令 · 文件 · Fake/生产数据面 adapter · API Key 鉴权。

## 快速开始

```bash
# 同级目录需有 f2b-spec（file: 依赖）
cd ../f2b-spec && pnpm install
cd ../f2b-sandbox && pnpm install
pnpm migrate   # 或启动时自动建表
F2B_SANDBOX_BACKEND=fake pnpm dev
```

默认监听 `http://0.0.0.0:13287`，**`F2B_AUTH_MODE=off`**（本地 / BFF 内网免密钥）。

```bash
curl -s http://127.0.0.1:13287/healthz
curl -s -X POST http://127.0.0.1:13287/v1/sandboxes \
  -H 'content-type: application/json' \
  -d '{"template":"base"}'
```

## API Key 鉴权

| 变量 | 说明 |
|------|------|
| `F2B_AUTH_MODE=off` | 默认；不校验密钥（开发 / 仅内网 BFF） |
| `F2B_AUTH_MODE=api_key` | `/v1/sandboxes*` 需 `Authorization: Bearer sk_live_…` 或 `X-API-Key` |
| `F2B_ADMIN_TOKEN` | 管理密钥创建/列表/吊销；`api_key` 模式必填 |

密钥 **只存 SHA-256 hash**；明文 `secret` **仅在创建响应出现一次**。

```bash
# 开启鉴权启动
F2B_AUTH_MODE=api_key F2B_ADMIN_TOKEN=dev-admin F2B_SANDBOX_BACKEND=fake pnpm dev

# 创建密钥（明文只返回一次）
curl -s -X POST http://127.0.0.1:13287/v1/api-keys \
  -H 'content-type: application/json' \
  -H 'x-f2b-admin-token: dev-admin' \
  -d '{"name":"ci"}'
# → { "key": { "id", "keyPrefix", ... }, "secret": "sk_live_…" }

# 业务调用
curl -s http://127.0.0.1:13287/v1/sandboxes \
  -H "authorization: Bearer sk_live_…"
```

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/v1/api-keys` | 列表 / 创建（需 admin） |
| DELETE | `/v1/api-keys/:id` | 吊销（需 admin） |
| GET/POST | `/v1/sandboxes` | 列表 / 创建 |
| GET/DELETE | `/v1/sandboxes/:id` | 详情 / 销毁 |
| POST | `/v1/sandboxes/:id/commands` | 命令（整包 JSON） |
| POST | `/v1/sandboxes/:id/commands/stream` | 命令（SSE：stdout/stderr/result） |
| GET/POST | `/v1/sandboxes/:id/files` | 文件 |

冒烟 / CI：

```bash
pnpm smoke              # auth=off 或带 F2B_API_KEY
pnpm smoke:auth         # 需 auth=api_key + F2B_ADMIN_TOKEN
pnpm smoke:stream       # SSE 流式命令
pnpm mock:cube          # 本地 mock CubeAPI(:18991) + envd(:18992)
pnpm smoke:cube         # 校准后的 cube/envd adapter（需 mock 或真集群）
pnpm smoke:capacity     # 需 F2B_MAX_CONCURRENT_SANDBOXES>0 → CAPACITY_EXCEEDED
pnpm ci:contract        # typecheck + fake/auth/capacity + mock cube → CONTRACT_CI_OK
```

GitHub Actions：`.github/workflows/ci.yml`（契约 + 镜像；`main` 推送 `ghcr.io/f2b-dev/sandbox`）。

## 数据面（Cube 控制面 + envd）

| 层 | 职责 |
|----|------|
| **CubeAPI** | 生命周期：`POST/GET/DELETE /sandboxes`（`templateID`、`timeout` 秒、`allow_internet_access`） |
| **envd** | 命令 Connect `POST /process.Process/Start`；文件 `GET/POST /files`；列目录 `ListDir` |

创建响应中的 `envdAccessToken` / `domain` **仅服务端**持有，不经 Control API 下发浏览器。无 KVM 时用 `pnpm mock:cube` + `pnpm smoke:cube` 验协议。

## 容器镜像

```bash
# 构建上下文为 f2b-spec / f2b-sandbox 的父目录
pnpm docker:build
# 等价：docker build -f f2b-sandbox/Dockerfile -t ghcr.io/f2b-dev/sandbox:local .

docker run --rm -p 13287:13287 \
  -e F2B_SANDBOX_BACKEND=fake \
  -e F2B_AUTH_MODE=off \
  ghcr.io/f2b-dev/sandbox:local
```

## 并发硬顶（单机）

| 变量 | 说明 |
|------|------|
| `F2B_MAX_CONCURRENT_SANDBOXES` | 限制 `provisioning`+`running`+`paused` 个数；未设或 ≤0 **不限制** |

超限：`POST /v1/sandboxes` → **429** `CAPACITY_EXCEEDED`（`details.active` / `details.max`）。  
分档建议见 f2b-docs `architecture/capacity`。

## 环境变量

见 [`.env.example`](./.env.example)。数据面管理密钥 **仅服务端**。

## 相关

- 契约：https://github.com/f2b-dev/f2b-spec  
- 组织：https://github.com/f2b-dev  
- 镜像：`ghcr.io/f2b-dev/sandbox`  

