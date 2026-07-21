# 构建上下文：与 f2b-spec 同级的父目录
#   docker build -f f2b-sandbox/Dockerfile -t ghcr.io/f2b-dev/sandbox:latest .
#
# 或在本仓：
#   docker build -f Dockerfile -t ghcr.io/f2b-dev/sandbox:latest ..

FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /workspace
COPY f2b-spec /workspace/f2b-spec
COPY f2b-sandbox /workspace/f2b-sandbox

WORKDIR /workspace/f2b-spec
RUN pnpm install --frozen-lockfile

WORKDIR /workspace/f2b-sandbox
# start 依赖 tsx（devDependency）
RUN pnpm install --frozen-lockfile

ENV F2B_SANDBOX_BACKEND=fake \
    F2B_AUTH_MODE=off \
    DATABASE_URL=file:/data/f2b-sandbox.db \
    PORT=13287 \
    HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 13287

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||13287)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
