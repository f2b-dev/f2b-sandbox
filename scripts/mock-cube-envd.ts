/**
 * 本地 mock：CubeAPI 控制面 + envd 数据面（无真 KVM）。
 * 供 cube adapter 契约测试：create/get/kill + Connect process + files。
 *
 * 启动：
 *   pnpm exec tsx scripts/mock-cube-envd.ts
 * 默认：CubeAPI :18991，envd :18992
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

const CUBE_PORT = Number(process.env.F2B_MOCK_CUBE_PORT ?? "18991");
const ENVD_PORT = Number(process.env.F2B_MOCK_ENVD_PORT ?? "18992");
const HOST = process.env.F2B_MOCK_HOST ?? "127.0.0.1";

type Session = {
  sandboxID: string;
  clientID: string;
  templateID: string;
  envdAccessToken: string;
  domain: string;
  state: string;
  files: Map<string, Buffer>;
  metadata?: Record<string, string>;
};

const sessions = new Map<string, Session>();

function json(res: ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function encodeConnectEnvelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}

function decodeConnectRequest(buf: Buffer): unknown {
  if (buf.length < 5) throw new Error("short connect frame");
  const size = buf.readUInt32BE(1);
  const payload = buf.subarray(5, 5 + size);
  return JSON.parse(payload.toString("utf8"));
}

function normalizePath(p: string): string {
  const raw = p.trim() || "/";
  const parts = raw.split("/").filter((s) => s && s !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return "/" + stack.join("/");
}

function sessionByToken(token: string | undefined): Session | undefined {
  if (!token) return undefined;
  for (const s of sessions.values()) {
    if (s.envdAccessToken === token) return s;
  }
  // 单 envd mock：无 token 时若仅一个会话则放行（联调友好）
  if (sessions.size === 1) return [...sessions.values()][0];
  return undefined;
}

function publicSandbox(s: Session) {
  return {
    sandboxID: s.sandboxID,
    clientID: s.clientID,
    templateID: s.templateID,
    envdVersion: "0.1.0-mock",
    envdAccessToken: s.envdAccessToken,
    trafficAccessToken: s.envdAccessToken,
    domain: s.domain,
    state: s.state,
  };
}

// ——— CubeAPI（控制面） ———
const cubeServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${CUBE_PORT}`);
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok", mock: true });
      return;
    }

    if (method === "POST" && url.pathname === "/sandboxes") {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8") || "{}") as {
        templateID?: string;
        timeout?: number;
        allow_internet_access?: boolean;
        metadata?: Record<string, string>;
      };
      if (!body.templateID) {
        json(res, 400, { message: "templateID required" });
        return;
      }
      const sandboxID = `cube${randomBytes(6).toString("hex")}`;
      const s: Session = {
        sandboxID,
        clientID: randomBytes(4).toString("hex"),
        templateID: body.templateID,
        envdAccessToken: randomBytes(16).toString("hex"),
        domain: "mock.local",
        state: "running",
        metadata: body.metadata,
        files: new Map([
          [
            "/home/user/README.md",
            Buffer.from(
              `# mock sandbox ${sandboxID}\ntemplate: ${body.templateID}\n`,
              "utf8",
            ),
          ],
        ]),
      };
      sessions.set(sandboxID, s);
      json(res, 201, publicSandbox(s));
      return;
    }

    const m = url.pathname.match(/^\/sandboxes\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const s = sessions.get(id);
      if (method === "GET") {
        if (!s) {
          json(res, 404, { message: "not found" });
          return;
        }
        json(res, 200, publicSandbox(s));
        return;
      }
      if (method === "DELETE") {
        if (s) sessions.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    json(res, 404, { message: `mock cube: ${method} ${url.pathname}` });
  } catch (err) {
    json(res, 500, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ——— envd（guest 数据面） ———
const envdServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${ENVD_PORT}`);
  const method = req.method ?? "GET";
  const token =
    (req.headers["x-access-token"] as string | undefined) ??
    (req.headers["X-Access-Token"] as string | undefined);
  const session = sessionByToken(token);

  try {
    if (method === "POST" && url.pathname === "/process.Process/Start") {
      if (!session) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const raw = await readBody(req);
      const reqBody = decodeConnectRequest(raw) as {
        process?: { cmd?: string; args?: string[]; cwd?: string };
      };
      const args = reqBody.process?.args ?? [];
      // /bin/bash -l -c <cmd>
      const cmd =
        args.length >= 3 && args[0] === "-l" && args[1] === "-c"
          ? args[2]!
          : args.join(" ") || reqBody.process?.cmd || "";

      let exitCode = 0;
      let stdout = "";
      let stderr = "";

      const trimmed = cmd.trim();
      if (trimmed.startsWith("echo ") && !trimmed.includes(">")) {
        stdout = stripQuotes(trimmed.slice(5).trim()) + "\n";
      } else if (trimmed.startsWith("cat ")) {
        const p = normalizePath(trimmed.slice(4).trim());
        const data = session.files.get(p);
        if (!data) {
          exitCode = 1;
          stderr = `cat: ${p}: No such file or directory\n`;
        } else {
          stdout = data.toString("utf8");
        }
      } else if (trimmed === "pwd") {
        stdout = (reqBody.process?.cwd ?? "/home/user") + "\n";
      } else {
        stdout = `[mock-envd] executed: ${trimmed}\n`;
      }

      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      const frames: Buffer[] = [];
      frames.push(
        encodeConnectEnvelope(
          Buffer.from(
            JSON.stringify({ event: { start: { pid: 42 } } }),
            "utf8",
          ),
        ),
      );
      if (stdout) {
        frames.push(
          encodeConnectEnvelope(
            Buffer.from(
              JSON.stringify({ event: { data: { stdout: b64(stdout) } } }),
              "utf8",
            ),
          ),
        );
      }
      if (stderr) {
        frames.push(
          encodeConnectEnvelope(
            Buffer.from(
              JSON.stringify({ event: { data: { stderr: b64(stderr) } } }),
              "utf8",
            ),
          ),
        );
      }
      frames.push(
        encodeConnectEnvelope(
          Buffer.from(
            JSON.stringify({ event: { end: { exitCode, exit_code: exitCode } } }),
            "utf8",
          ),
        ),
      );
      // Connect end-stream empty frame (flags 0x02)
      frames.push(encodeConnectEnvelope(new Uint8Array(0), 0x02));

      const body = Buffer.concat(frames);
      res.writeHead(200, {
        "content-type": "application/connect+json",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }

    if (url.pathname === "/files") {
      if (!session) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      const path = normalizePath(url.searchParams.get("path") ?? "/");
      if (method === "GET") {
        const data = session.files.get(path);
        if (!data) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": data.length,
        });
        res.end(data);
        return;
      }
      if (method === "POST") {
        const raw = await readBody(req);
        // 支持裸 octet-stream；multipart 则取全部 body 兜底
        session.files.set(path, raw);
        res.writeHead(200);
        res.end();
        return;
      }
    }

    if (method === "POST" && url.pathname === "/filesystem.Filesystem/ListDir") {
      if (!session) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8") || "{}") as { path?: string };
      const dir = normalizePath(body.path ?? "/");
      const entries: Array<{
        path: string;
        name: string;
        type: string;
        size?: number;
      }> = [];
      const seen = new Set<string>();
      for (const [p, data] of session.files) {
        if (!p.startsWith(dir === "/" ? "/" : dir + "/") && p !== dir) continue;
        if (p === dir) continue;
        const rest = p.slice(dir === "/" ? 1 : dir.length + 1);
        const name = rest.split("/")[0]!;
        const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
        if (seen.has(full)) continue;
        seen.add(full);
        if (rest.includes("/")) {
          entries.push({ path: full, name, type: "directory" });
        } else {
          entries.push({
            path: full,
            name,
            type: "file",
            size: data.length,
          });
        }
      }
      json(res, 200, { entries });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `mock envd: ${method} ${url.pathname}` }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
});

function stripQuotes(s: string) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

cubeServer.listen(CUBE_PORT, HOST, () => {
  console.log(`mock CubeAPI http://${HOST}:${CUBE_PORT}`);
});
envdServer.listen(ENVD_PORT, HOST, () => {
  console.log(`mock envd    http://${HOST}:${ENVD_PORT}`);
  console.log("MOCK_CUBE_ENVD_READY");
});
