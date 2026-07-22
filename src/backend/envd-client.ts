/**
 * 数据面 guest 内 envd（E2B 兼容）：命令 Connect 流 + 文件 HTTP。
 * 控制面 create 返回的 envdAccessToken / domain 仅服务端持有。
 */

export type EnvdSession = {
  sandboxId: string;
  envdAccessToken?: string;
  domain?: string;
  clientId?: string;
  envdVersion?: string;
};

export type EnvdClientOptions = {
  /** 覆盖默认 `{port}-{sandboxId}.{domain}`，联调 mock 时用 */
  baseUrl?: string;
  scheme?: string;
  domain?: string;
  envdPort?: number;
  fetchImpl?: typeof fetch;
};

export type EnvdRunCommandInput = {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  user?: string;
};

const CONNECT_PROTOCOL_VERSION = "1";
const CONNECT_CONTENT_TYPE = "application/connect+json";
const CONNECT_END_STREAM = 0x02;
const CONNECT_COMPRESSED = 0x01;

function encodeConnectEnvelope(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = 0;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

async function readConnectEnvelope(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  carry: { buf: Uint8Array },
): Promise<{ flags: number; payload: Uint8Array } | null> {
  const ensure = async (n: number) => {
    while (carry.buf.length < n) {
      const { done, value } = await reader.read();
      if (done) return false;
      const next = new Uint8Array(carry.buf.length + value.length);
      next.set(carry.buf);
      next.set(value, carry.buf.length);
      carry.buf = next;
    }
    return true;
  };

  if (!(await ensure(5))) {
    if (carry.buf.length === 0) return null;
    throw new Error("envd Connect stream truncated header");
  }
  const flags = carry.buf[0]!;
  const size = new DataView(
    carry.buf.buffer,
    carry.buf.byteOffset,
    carry.buf.byteLength,
  ).getUint32(1, false);
  if (!(await ensure(5 + size))) {
    throw new Error("envd Connect stream truncated payload");
  }
  const payload = carry.buf.slice(5, 5 + size);
  carry.buf = carry.buf.slice(5 + size);
  return { flags, payload };
}

function basicAuthUser(user = "root"): string {
  return `Basic ${Buffer.from(`${user}:`, "utf8").toString("base64")}`;
}

function decodeProcessBytes(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
}

export class EnvdClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl?: string;
  private readonly scheme: string;
  private readonly domain: string;
  private readonly envdPort: number;

  constructor(opts: EnvdClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl?.replace(/\/$/, "");
    this.scheme = (opts.scheme ?? "http").replace(/:$/, "");
    this.domain = opts.domain ?? "cube.app";
    this.envdPort = opts.envdPort ?? 49983;
  }

  private guestOrigin(session: EnvdSession): string {
    if (this.baseUrl) return this.baseUrl;
    const domain = session.domain?.trim() || this.domain;
    return `${this.scheme}://${this.envdPort}-${session.sandboxId}.${domain}`;
  }

  private headers(
    session: EnvdSession,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (session.envdAccessToken) {
      h["X-Access-Token"] = session.envdAccessToken;
    }
    return h;
  }

  async runCommand(
    session: EnvdSession,
    input: EnvdRunCommandInput,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const body = {
      process: {
        cmd: "/bin/bash",
        args: ["-l", "-c", input.cmd],
        envs: input.env ?? {},
        ...(input.cwd ? { cwd: input.cwd } : {}),
      },
      stdin: false,
    };
    const payload = encodeConnectEnvelope(
      new TextEncoder().encode(JSON.stringify(body)),
    );
    const url = `${this.guestOrigin(session)}/process.Process/Start`;
    const headers = this.headers(session, {
      "Content-Type": CONNECT_CONTENT_TYPE,
      "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      "Connect-Content-Encoding": "identity",
      Authorization: basicAuthUser(input.user),
    });
    if (input.timeoutMs && input.timeoutMs > 0) {
      headers["Connect-Timeout-Ms"] = String(input.timeoutMs);
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: Buffer.from(payload),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`envd process start HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const carry = { buf: new Uint8Array() };
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let sawEnd = false;

    for (;;) {
      const msg = await readConnectEnvelope(reader, carry);
      if (!msg) break;
      if (msg.flags & CONNECT_COMPRESSED) {
        throw new Error("envd compressed Connect frames not supported");
      }
      if (msg.flags & CONNECT_END_STREAM) {
        if (msg.payload.length) {
          const end = JSON.parse(new TextDecoder().decode(msg.payload)) as {
            error?: { code?: string; message?: string };
          };
          if (end.error?.message) {
            throw new Error(
              end.error.code
                ? `${end.error.code}: ${end.error.message}`
                : end.error.message,
            );
          }
        }
        continue;
      }
      const response = JSON.parse(new TextDecoder().decode(msg.payload)) as {
        event?: {
          start?: { pid?: number };
          data?: { stdout?: string; stderr?: string };
          end?: {
            exitCode?: number;
            exit_code?: number;
            error?: string;
          };
        };
      };
      const ev = response.event;
      if (!ev) continue;
      if (ev.data?.stdout) stdout += decodeProcessBytes(ev.data.stdout);
      if (ev.data?.stderr) stderr += decodeProcessBytes(ev.data.stderr);
      if (ev.end) {
        const code = ev.end.exitCode ?? ev.end.exit_code;
        if (code === undefined) {
          if (ev.end.error) throw new Error(`process failed: ${ev.end.error}`);
          throw new Error("process EndEvent missing exit code");
        }
        exitCode = code;
        sawEnd = true;
      }
    }

    if (!sawEnd) {
      throw new Error("envd process stream ended without EndEvent");
    }
    return { exitCode, stdout, stderr };
  }

  async writeFile(
    session: EnvdSession,
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    const url = `${this.guestOrigin(session)}/files?path=${encodeURIComponent(path)}`;
    const bodyBuf = Buffer.from(data);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/octet-stream",
      }),
      body: bodyBuf,
    });
    if (res.ok) return;
    // 兼容仅接受 multipart 的 envd
    const form = new FormData();
    form.append(
      "file",
      new Blob([bodyBuf]),
      path.split("/").pop() || "file",
    );
    const res2 = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(session),
      body: form,
    });
    if (!res2.ok) {
      const text = await res2.text().catch(() => "");
      throw new Error(`envd write file HTTP ${res2.status}: ${text.slice(0, 300)}`);
    }
  }

  async readFile(session: EnvdSession, path: string): Promise<Uint8Array> {
    const url = `${this.guestOrigin(session)}/files?path=${encodeURIComponent(path)}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(session),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`envd read file HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async listFiles(
    session: EnvdSession,
    path: string,
  ): Promise<
    Array<{ path: string; name: string; isDir: boolean; size?: number }>
  > {
    const url = `${this.guestOrigin(session)}/filesystem.Filesystem/ListDir`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      }),
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`envd list dir HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      entries?: Array<{
        path?: string;
        name?: string;
        type?: string;
        size?: number;
      }>;
    };
    return (data.entries ?? []).map((e) => {
      const name = e.name ?? e.path?.split("/").filter(Boolean).pop() ?? "";
      const p = e.path ?? `${path.replace(/\/$/, "")}/${name}`;
      const isDir =
        e.type === "directory" ||
        e.type === "dir" ||
        String(e.type).toLowerCase() === "directory";
      return { path: p, name, isDir, size: e.size };
    });
  }

  /** 删除 guest 文件/目录：先 HTTP DELETE /files，再 Connect Remove */
  async deleteFile(
    session: EnvdSession,
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const q = new URLSearchParams({ path });
    if (opts?.recursive) q.set("recursive", "true");
    const httpUrl = `${this.guestOrigin(session)}/files?${q.toString()}`;
    const del = await this.fetchImpl(httpUrl, {
      method: "DELETE",
      headers: this.headers(session),
    });
    if (del.ok) return;

    const connectUrl = `${this.guestOrigin(session)}/filesystem.Filesystem/Remove`;
    const res = await this.fetchImpl(connectUrl, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      }),
      body: JSON.stringify({ path, recursive: Boolean(opts?.recursive) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const status = res.status || del.status;
      throw new Error(
        `envd delete file HTTP ${status}: ${text.slice(0, 300) || del.status}`,
      );
    }
  }

  /** 创建目录：Connect MakeDir，失败再尝试 shell mkdir */
  async mkdir(
    session: EnvdSession,
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const recursive = opts?.recursive !== false;
    const connectUrl = `${this.guestOrigin(session)}/filesystem.Filesystem/MakeDir`;
    const res = await this.fetchImpl(connectUrl, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      }),
      body: JSON.stringify({ path }),
    });
    if (res.ok) return;

    // 回退：部分 envd 版本无 MakeDir
    const shell = recursive
      ? `mkdir -p ${JSON.stringify(path)}`
      : `mkdir ${JSON.stringify(path)}`;
    const startUrl = `${this.guestOrigin(session)}/process.Process/Start`;
    const start = await this.fetchImpl(startUrl, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      }),
      body: JSON.stringify({
        process: { cmd: "/bin/sh", args: ["-c", shell] },
      }),
    });
    if (!start.ok) {
      const text = await start.text().catch(() => "");
      const prev = await res.text().catch(() => "");
      throw new Error(
        `envd mkdir HTTP ${start.status}: ${text.slice(0, 200) || prev.slice(0, 200)}`,
      );
    }
  }

  /** 重命名/移动：Connect Move，失败再 shell mv */
  async rename(
    session: EnvdSession,
    from: string,
    to: string,
  ): Promise<void> {
    const connectUrl = `${this.guestOrigin(session)}/filesystem.Filesystem/Move`;
    const res = await this.fetchImpl(connectUrl, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      }),
      body: JSON.stringify({ source: from, destination: to }),
    });
    if (res.ok) return;

    const shell = `mv ${JSON.stringify(from)} ${JSON.stringify(to)}`;
    const startUrl = `${this.guestOrigin(session)}/process.Process/Start`;
    const start = await this.fetchImpl(startUrl, {
      method: "POST",
      headers: this.headers(session, {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      }),
      body: JSON.stringify({
        process: { cmd: "/bin/sh", args: ["-c", shell] },
      }),
    });
    if (!start.ok) {
      const text = await start.text().catch(() => "");
      const prev = await res.text().catch(() => "");
      throw new Error(
        `envd rename HTTP ${start.status}: ${text.slice(0, 200) || prev.slice(0, 200)}`,
      );
    }
  }
}
