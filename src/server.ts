import http from "node:http";
import { createSandboxBackend } from "./backend";
import { resolveDatabasePath } from "./db/client";
import "./db/migrate-inline";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "./db/api-keys";
import {
  authenticateRequest,
  assertAdmin,
  resolveAuthMode,
} from "./auth";
import {
  createSandbox,
  getSandbox,
  killSandbox,
  listSandboxFiles,
  listSandboxes,
  readSandboxFile,
  runSandboxCommand,
  writeSandboxFile,
} from "./service";
import { json, jsonError, readJson } from "./http";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

function notFound() {
  return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  try {
    if (method === "GET" && (pathname === "/healthz" || pathname === "/")) {
      const backend = createSandboxBackend();
      return json({
        ok: true,
        service: "f2b-sandbox",
        backend: backend.kind,
        auth: resolveAuthMode(),
        db: resolveDatabasePath(),
      });
    }

    // --- API Key 管理（明文只在 POST 创建响应出现一次）---
    if (pathname === "/v1/api-keys") {
      if (method === "GET") {
        assertAdmin(req);
        const projectId = url.searchParams.get("projectId") ?? undefined;
        return json({ keys: listApiKeys(projectId) });
      }
      if (method === "POST") {
        assertAdmin(req);
        const body = (await readJson(req)) as {
          name?: string;
          projectId?: string;
        };
        const { record, plaintext } = createApiKey({
          name: body.name ?? "default",
          projectId: body.projectId,
        });
        return json(
          {
            key: record,
            /** 明文仅此一次；客户端须立即保存 */
            secret: plaintext,
          },
          201,
        );
      }
    }

    const keyIdMatch = pathname.match(/^\/v1\/api-keys\/([^/]+)$/);
    if (keyIdMatch && method === "DELETE") {
      assertAdmin(req);
      const id = decodeURIComponent(keyIdMatch[1]!);
      const key = revokeApiKey(id);
      if (!key) {
        return json(
          { error: { code: "NOT_FOUND", message: "api key not found" } },
          404,
        );
      }
      return json({ key });
    }

    // --- 沙箱产品 API：按 F2B_AUTH_MODE 鉴权 ---
    if (pathname.startsWith("/v1/")) {
      authenticateRequest(req);
    }

    if (pathname === "/v1/sandboxes") {
      if (method === "GET") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        const sandboxes = await listSandboxes(projectId);
        return json({ sandboxes });
      }
      if (method === "POST") {
        const body = await readJson(req);
        const sandbox = await createSandbox(body);
        return json({ sandbox }, 201);
      }
    }

    const idMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);
      if (method === "GET") {
        const sandbox = await getSandbox(id);
        return json({ sandbox });
      }
      if (method === "DELETE") {
        const sandbox = await killSandbox(id);
        return json({ sandbox });
      }
    }

    const cmdMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/commands$/);
    if (cmdMatch && method === "POST") {
      const id = decodeURIComponent(cmdMatch[1]!);
      const body = await readJson(req);
      const result = await runSandboxCommand(id, body);
      return json({ result });
    }

    const filesMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files$/);
    if (filesMatch) {
      const id = decodeURIComponent(filesMatch[1]!);
      if (method === "GET") {
        const filePath = url.searchParams.get("path");
        const list = url.searchParams.get("list");
        if (list === "1" || list === "true") {
          const entries = await listSandboxFiles(id, filePath ?? "/home/user");
          return json({ entries });
        }
        if (!filePath) {
          return json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "path query required (or list=1)",
              },
            },
            400,
          );
        }
        const encoding = url.searchParams.get("encoding") ?? "utf8";
        const file = await readSandboxFile(id, { path: filePath, encoding });
        return json({ file });
      }
      if (method === "POST") {
        const body = await readJson(req);
        const result = await writeSandboxFile(id, body);
        return json(result, 201);
      }
    }

    return notFound();
  } catch (err) {
    return jsonError(err);
  }
}

const nodeServer = http.createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host ?? `localhost:${port}`;
    const url = `http://${hostHeader}${req.url ?? "/"}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBuf = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : bodyBuf.length
            ? bodyBuf
            : undefined,
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const ab = await response.arrayBuffer();
    res.end(Buffer.from(ab));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          code: "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
});

nodeServer.listen(port, host, () => {
  const backend = createSandboxBackend();
  console.log(
    `f2b-sandbox listening on http://${host}:${port} backend=${backend.kind} auth=${resolveAuthMode()} db=${resolveDatabasePath()}`,
  );
});
