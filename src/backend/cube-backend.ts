import type {
  CommandResult,
  FileEntry,
  SandboxStatus,
} from "@f2b/spec";
import { ErrorCode, F2bError } from "@f2b/spec";
import { EnvdClient, type EnvdSession } from "./envd-client";
import type {
  BackendSandboxHandle,
  CreateSandboxBackendRequest,
  RunCommandInput,
  SandboxBackend,
} from "./types";

export type CubeClientOptions = {
  /** 控制面 CubeAPI 根 URL（仅服务端） */
  baseUrl: string;
  /** API Key；兼容 X-API-Key / Bearer */
  token?: string;
  fetchImpl?: typeof fetch;
  /**
   * 覆盖 envd 基址（联调 mock 时设为 mock envd URL）。
   * 生产由 `{envdPort}-{sandboxID}.{domain}` 解析。
   */
  envdBaseUrl?: string;
  envdScheme?: string;
  /** 默认 cube.app；也可用 F2B_CUBE_SANDBOX_DOMAIN */
  sandboxDomain?: string;
  envdPort?: number;
};

type CubeSandboxWire = {
  sandboxID?: string;
  id?: string;
  templateID?: string;
  clientID?: string;
  envdVersion?: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
  domain?: string;
  state?: string;
  status?: string;
};

/**
 * 生产数据面客户端（CubeAPI 控制面 + envd guest 数据面）。
 *
 * - 生命周期：POST/GET/DELETE `/sandboxes`（E2B 兼容字段 templateID / sandboxID / allow_internet_access）
 * - 命令 / 文件：envd（Connect `/process.Process/Start`、`/files`），**不是** CubeAPI `/commands`
 * - 字段与路径以 CubeSandbox openapi.yml + 官方 Go SDK 为准
 *
 * 未配置 F2B_CUBE_API_URL 时不应实例化（用 FakeSandboxBackend）。
 */
export class CubeSandboxBackend implements SandboxBackend {
  readonly kind = "cube" as const;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly envd: EnvdClient;
  /** remoteId → envd 会话（进程内缓存；重启后 get() 会再拉） */
  private readonly sessions = new Map<string, EnvdSession>();

  constructor(opts: CubeClientOptions) {
    if (!opts.baseUrl) {
      throw new F2bError(
        ErrorCode.BACKEND_UNAVAILABLE,
        "F2B_CUBE_API_URL (or CUBE_API_URL) is empty",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.envd = new EnvdClient({
      baseUrl: opts.envdBaseUrl,
      scheme: opts.envdScheme,
      domain: opts.sandboxDomain,
      envdPort: opts.envdPort,
      fetchImpl: this.fetchImpl,
    });
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.token) {
      // Cube / E2B：X-API-Key 优先；同时带 Bearer 兼容
      h["X-API-Key"] = this.token;
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new F2bError(
        ErrorCode.BACKEND_UNAVAILABLE,
        "sandbox data-plane control API unreachable",
        { cause: err },
      );
    }
    if (res.status === 204) {
      return { status: 204, data: undefined as T };
    }
    const text = await res.text().catch(() => "");
    let data: T = undefined as T;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }
    }
    if (!res.ok) {
      throw new F2bError(
        ErrorCode.BACKEND_UNAVAILABLE,
        `data-plane API ${res.status}`,
        {
          status: res.status === 404 ? 404 : res.status >= 500 ? 503 : res.status,
          details:
            typeof data === "object" && data
              ? data
              : String(text).slice(0, 500),
        },
      );
    }
    return { status: res.status, data };
  }

  private remember(session: EnvdSession) {
    this.sessions.set(session.sandboxId, session);
  }

  private sessionFor(remoteId: string): EnvdSession {
    const cached = this.sessions.get(remoteId);
    if (cached) return cached;
    return { sandboxId: remoteId };
  }

  private handleFromWire(
    data: CubeSandboxWire,
    localSandboxId: string,
  ): BackendSandboxHandle {
    const remoteId = data.sandboxID ?? data.id;
    if (!remoteId) {
      throw new F2bError(
        ErrorCode.BACKEND_UNAVAILABLE,
        "data-plane create/get response missing sandboxID",
        { details: data },
      );
    }
    const envd: EnvdSession = {
      sandboxId: remoteId,
      envdAccessToken: data.envdAccessToken,
      domain: data.domain,
      clientId: data.clientID,
      envdVersion: data.envdVersion,
    };
    this.remember(envd);
    return {
      sandboxId: localSandboxId,
      remoteId,
      backend: this.kind,
      status: mapCubeState(data.state ?? data.status) ?? "running",
      envd,
    };
  }

  async create(req: CreateSandboxBackendRequest): Promise<BackendSandboxHandle> {
    // NewSandbox：templateID 必填；allow_internet_access 为 SDK snake_case quirk
    const body: Record<string, unknown> = {
      templateID: req.template,
      allow_internet_access: req.allowInternetAccess,
      metadata: {
        ...(req.metadata ?? {}),
        f2b_sandbox_id: req.sandboxId,
        f2b_name: req.name ?? "",
      },
    };
    if (req.timeoutMs != null && req.timeoutMs > 0) {
      body.timeout = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    }

    const { data } = await this.request<CubeSandboxWire>(
      "POST",
      "/sandboxes",
      body,
    );
    return this.handleFromWire(data, req.sandboxId);
  }

  async get(remoteId: string): Promise<BackendSandboxHandle | null> {
    try {
      const { data } = await this.request<CubeSandboxWire>(
        "GET",
        `/sandboxes/${encodeURIComponent(remoteId)}`,
      );
      return this.handleFromWire(data, remoteId);
    } catch (err) {
      if (err instanceof F2bError && err.status === 404) return null;
      throw err;
    }
  }

  async kill(remoteId: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/sandboxes/${encodeURIComponent(remoteId)}`,
      );
    } finally {
      this.sessions.delete(remoteId);
    }
  }

  async runCommand(
    remoteId: string,
    input: RunCommandInput,
  ): Promise<CommandResult> {
    const started = Date.now();
    const session = this.sessionFor(remoteId);
    // 无 token 时尝试 refresh get
    if (!session.envdAccessToken && !session.domain) {
      await this.get(remoteId);
    }
    const s = this.sessionFor(remoteId);
    try {
      const result = await this.envd.runCommand(s, {
        cmd: input.cmd,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        env: input.env,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }

  async writeFile(
    remoteId: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    const session = this.sessionFor(remoteId);
    try {
      await this.envd.writeFile(session, path, bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }

  async readFile(remoteId: string, path: string): Promise<Uint8Array> {
    const session = this.sessionFor(remoteId);
    try {
      return await this.envd.readFile(session, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }

  async listFiles(remoteId: string, path = "/"): Promise<FileEntry[]> {
    const session = this.sessionFor(remoteId);
    try {
      const entries = await this.envd.listFiles(session, path);
      return entries.map((e) => ({
        path: e.path,
        name: e.name,
        type: e.isDir ? ("dir" as const) : ("file" as const),
        size: e.size,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }

  async deleteFile(
    remoteId: string,
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const session = this.sessionFor(remoteId);
    try {
      await this.envd.deleteFile(session, path, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found|404/i.test(message)) {
        throw new F2bError(ErrorCode.NOT_FOUND, message, {
          status: 404,
          cause: err,
        });
      }
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }

  async mkdir(
    remoteId: string,
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const session = this.sessionFor(remoteId);
    try {
      await this.envd.mkdir(session, path, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/EEXIST|exists/i.test(message)) {
        throw new F2bError(ErrorCode.VALIDATION_ERROR, message, { cause: err });
      }
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }

  async rename(remoteId: string, from: string, to: string): Promise<void> {
    const session = this.sessionFor(remoteId);
    try {
      await this.envd.rename(session, from, to);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found|404/i.test(message)) {
        throw new F2bError(ErrorCode.NOT_FOUND, message, {
          status: 404,
          cause: err,
        });
      }
      if (/EEXIST|exists/i.test(message)) {
        throw new F2bError(ErrorCode.VALIDATION_ERROR, message, { cause: err });
      }
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
    }
  }
}

function mapCubeState(s?: string): SandboxStatus | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  // Cube SandboxState: running | paused | pausing
  if (v === "running" || v === "ready") return "running";
  if (v === "paused" || v === "pausing") return "paused";
  if (v === "killed" || v === "stopped") return "killed";
  if (v === "failed" || v === "error") return "failed";
  if (v === "provisioning" || v === "starting") return "provisioning";
  return undefined;
}
