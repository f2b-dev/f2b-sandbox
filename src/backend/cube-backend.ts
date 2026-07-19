import type {
  CommandResult,
  FileEntry,
  SandboxStatus,
} from "@f2b/spec";
import { ErrorCode, F2bError } from "@f2b/spec";
import type {
  BackendSandboxHandle,
  CreateSandboxBackendRequest,
  SandboxBackend,
} from "./types";

export type CubeClientOptions = {
  baseUrl: string;
  /** 仅服务端使用；禁止进入浏览器 */
  token?: string;
  fetchImpl?: typeof fetch;
};

/**
 * CubeSandbox / data-plane API HTTP 客户端骨架。
 * 路径按 E2B 兼容风格预留；真集群联调时以官方 OpenAPI 校准。
 * 未配置 CUBE_API_URL 时不应实例化本类（用 FakeSandboxBackend）。
 */
export class CubeSandboxBackend implements SandboxBackend {
  readonly kind = "cube" as const;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

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
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, "sandbox data-plane API unreachable", {
        cause: err,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, `data-plane API ${res.status}`, {
        status: res.status >= 500 ? 503 : res.status,
        details: text.slice(0, 500),
      });
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async create(req: CreateSandboxBackendRequest): Promise<BackendSandboxHandle> {
    // 预留 E2B 风格 POST /sandboxes；字段名待官方 schema 对齐
    const data = await this.request<{
      sandboxID?: string;
      id?: string;
      status?: string;
    }>("POST", "/sandboxes", {
      templateID: req.template,
      timeout: req.timeoutMs ? Math.ceil(req.timeoutMs / 1000) : undefined,
      metadata: {
        ...(req.metadata ?? {}),
        lingjing_sandbox_id: req.sandboxId,
        lingjing_name: req.name ?? "",
        allow_internet: String(req.allowInternetAccess),
      },
    });
    const remoteId = data.sandboxID ?? data.id;
    if (!remoteId) {
      throw new F2bError(
        ErrorCode.BACKEND_UNAVAILABLE,
        "data-plane API create response missing sandbox id",
        { details: data },
      );
    }
    return {
      sandboxId: req.sandboxId,
      remoteId,
      backend: this.kind,
      status: mapCubeStatus(data.status) ?? "running",
    };
  }

  async get(remoteId: string): Promise<BackendSandboxHandle | null> {
    try {
      const data = await this.request<{
        sandboxID?: string;
        id?: string;
        status?: string;
      }>("GET", `/sandboxes/${encodeURIComponent(remoteId)}`);
      const id = data.sandboxID ?? data.id ?? remoteId;
      return {
        sandboxId: id,
        remoteId: id,
        backend: this.kind,
        status: mapCubeStatus(data.status) ?? "running",
      };
    } catch (err) {
      if (err instanceof F2bError && err.status === 404) return null;
      throw err;
    }
  }

  async kill(remoteId: string): Promise<void> {
    await this.request("DELETE", `/sandboxes/${encodeURIComponent(remoteId)}`);
  }

  async runCommand(
    remoteId: string,
    input: {
      cmd: string;
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<CommandResult> {
    const started = Date.now();
    const data = await this.request<{
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }>("POST", `/sandboxes/${encodeURIComponent(remoteId)}/commands`, {
      command: input.cmd,
      cwd: input.cwd,
      timeout: input.timeoutMs,
      envs: input.env,
    });
    return {
      exitCode: data.exitCode ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      durationMs: Date.now() - started,
    };
  }

  async writeFile(
    remoteId: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const content =
      typeof data === "string"
        ? Buffer.from(data, "utf8").toString("base64")
        : Buffer.from(data).toString("base64");
    await this.request(
      "POST",
      `/sandboxes/${encodeURIComponent(remoteId)}/files`,
      { path, content, encoding: "base64" },
    );
  }

  async readFile(remoteId: string, path: string): Promise<Uint8Array> {
    const data = await this.request<{ content?: string; encoding?: string }>(
      "GET",
      `/sandboxes/${encodeURIComponent(remoteId)}/files?path=${encodeURIComponent(path)}`,
    );
    const raw = data.content ?? "";
    if (data.encoding === "base64" || looksBase64(raw)) {
      return Buffer.from(raw, "base64");
    }
    return Buffer.from(raw, "utf8");
  }

  async listFiles(remoteId: string, path = "/"): Promise<FileEntry[]> {
    const data = await this.request<{ entries?: FileEntry[] }>(
      "GET",
      `/sandboxes/${encodeURIComponent(remoteId)}/files/list?path=${encodeURIComponent(path)}`,
    );
    return data.entries ?? [];
  }
}

function mapCubeStatus(s?: string): SandboxStatus | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v === "running" || v === "ready") return "running";
  if (v === "paused") return "paused";
  if (v === "killed" || v === "stopped") return "killed";
  if (v === "failed" || v === "error") return "failed";
  if (v === "provisioning" || v === "starting") return "provisioning";
  return undefined;
}

function looksBase64(s: string) {
  return /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length % 4 === 0 && s.length > 16;
}
