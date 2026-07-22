import type {
  CommandResult,
  CommandStreamEvent,
  FileEntry,
  SandboxStatus,
} from "@f2b/spec";
import type {
  BackendSandboxHandle,
  CreateSandboxBackendRequest,
  RunCommandInput,
  SandboxBackend,
} from "./types";

type FakeState = {
  handle: BackendSandboxHandle;
  files: Map<string, Uint8Array>;
  createdAt: number;
};

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

const GLOBAL_KEY = "__lingjing_fake_sandbox_sessions__";

function globalSessions(): Map<string, FakeState> {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: Map<string, FakeState>;
  };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY];
}

/**
 * 无 KVM / 无 Cube 时的内存沙箱：契约与 Cube 后端一致，供控制台与 SDK 联调。
 * 会话挂在 globalThis，避免 Next 热重载 / 多模块实例丢状态。
 */
export class FakeSandboxBackend implements SandboxBackend {
  readonly kind = "fake" as const;

  private get sessions() {
    return globalSessions();
  }

  async create(req: CreateSandboxBackendRequest): Promise<BackendSandboxHandle> {
    const remoteId = `fake-${req.sandboxId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
    const handle: BackendSandboxHandle = {
      sandboxId: req.sandboxId,
      remoteId,
      backend: this.kind,
      status: "running",
    };
    const files = new Map<string, Uint8Array>();
    files.set(
      "/home/user/README.md",
      new TextEncoder().encode(
        `# Sandbox ${req.sandboxId}\n\ntemplate: ${req.template}\ninternet: ${req.allowInternetAccess}\n`,
      ),
    );
    this.sessions.set(remoteId, {
      handle,
      files,
      createdAt: Date.now(),
    });
    return handle;
  }

  async get(remoteId: string): Promise<BackendSandboxHandle | null> {
    return this.sessions.get(remoteId)?.handle ?? null;
  }

  async kill(remoteId: string): Promise<void> {
    const s = this.sessions.get(remoteId);
    if (!s) return;
    s.handle = { ...s.handle, status: "killed" as SandboxStatus };
    this.sessions.delete(remoteId);
  }

  async pause(remoteId: string): Promise<BackendSandboxHandle> {
    const s = this.require(remoteId);
    if (s.handle.status === "paused") return s.handle;
    if (s.handle.status !== "running") {
      throw new Error(`cannot pause sandbox in status ${s.handle.status}`);
    }
    s.handle = { ...s.handle, status: "paused" };
    return s.handle;
  }

  async resume(remoteId: string): Promise<BackendSandboxHandle> {
    const s = this.require(remoteId);
    if (s.handle.status === "running") return s.handle;
    if (s.handle.status !== "paused") {
      throw new Error(`cannot resume sandbox in status ${s.handle.status}`);
    }
    s.handle = { ...s.handle, status: "running" };
    return s.handle;
  }

  async runCommand(
    remoteId: string,
    input: RunCommandInput,
  ): Promise<CommandResult> {
    const s = this.require(remoteId);
    if (s.handle.status === "paused") {
      throw new Error("sandbox is paused");
    }
    return this.exec(s, input);
  }

  async *streamCommand(
    remoteId: string,
    input: RunCommandInput,
  ): AsyncIterable<CommandStreamEvent> {
    const s = this.require(remoteId);
    if (s.handle.status === "paused") {
      yield {
        type: "error",
        code: "SANDBOX_NOT_RUNNING",
        message: "sandbox is paused",
      };
      return;
    }
    const started = Date.now();
    const cmd = input.cmd.trim();

    // 模拟分片输出，便于客户端验证 SSE 多事件
    if (cmd.startsWith("echo ") && !cmd.includes(">")) {
      const text = stripQuotes(cmd.slice(5).trim()) + "\n";
      const mid = Math.max(1, Math.ceil(text.length / 2));
      const a = text.slice(0, mid);
      const b = text.slice(mid);
      if (a) {
        await delay(5);
        yield { type: "stdout", text: a };
      }
      if (b) {
        await delay(5);
        yield { type: "stdout", text: b };
      }
      yield {
        type: "result",
        result: {
          exitCode: 0,
          stdout: text,
          stderr: "",
          durationMs: Date.now() - started,
        },
      };
      return;
    }

    const result = this.exec(s, input);
    if (result.stdout) yield { type: "stdout", text: result.stdout };
    if (result.stderr) yield { type: "stderr", text: result.stderr };
    yield { type: "result", result };
  }

  private exec(
    s: FakeState,
    input: RunCommandInput,
  ): CommandResult {
    const started = Date.now();
    const cmd = input.cmd.trim();

    // 极简 shell 模拟：echo / cat / ls / pwd / 写文件 echo > path
    if (cmd === "pwd") {
      return ok(started, input.cwd ?? "/home/user", "");
    }
    if (cmd.startsWith("echo ")) {
      const rest = cmd.slice(5);
      const redir = rest.match(/^(.*)>(\s*)(.+)$/);
      if (redir) {
        const content = stripQuotes(redir[1]!.trim()) + "\n";
        const path = normalizePath(redir[3]!.trim());
        s.files.set(path, new TextEncoder().encode(content));
        return ok(started, "", "");
      }
      return ok(started, stripQuotes(rest) + "\n", "");
    }
    if (cmd.startsWith("cat ")) {
      const path = normalizePath(cmd.slice(4).trim());
      const data = s.files.get(path);
      if (!data) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `cat: ${path}: No such file or directory\n`,
          durationMs: Date.now() - started,
        };
      }
      return ok(started, new TextDecoder().decode(data), "");
    }
    if (cmd === "ls" || cmd.startsWith("ls ")) {
      const arg = cmd === "ls" ? "/home/user" : cmd.slice(3).trim() || "/home/user";
      const dir = normalizePath(arg);
      const names = new Set<string>();
      for (const p of s.files.keys()) {
        if (p.startsWith(dir === "/" ? "/" : dir + "/")) {
          const rest = p.slice(dir === "/" ? 1 : dir.length + 1);
          const name = rest.split("/")[0];
          if (name) names.add(name);
        }
      }
      const list = [...names].sort().join("\n") + (names.size ? "\n" : "");
      return ok(started, list, "");
    }

    return ok(started, `[fake] executed: ${cmd}\n`, "");
  }

  async writeFile(
    remoteId: string,
    path: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const s = this.require(remoteId);
    const buf =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    s.files.set(normalizePath(path), buf);
  }

  async readFile(remoteId: string, path: string): Promise<Uint8Array> {
    const s = this.require(remoteId);
    const data = s.files.get(normalizePath(path));
    if (!data) {
      throw new Error(`ENOENT: ${path}`);
    }
    return data;
  }

  async listFiles(remoteId: string, path = "/home/user"): Promise<FileEntry[]> {
    const s = this.require(remoteId);
    const dir = normalizePath(path);
    const entries = new Map<string, FileEntry>();
    for (const [p, data] of s.files) {
      if (!p.startsWith(dir === "/" ? "/" : dir + "/") && p !== dir) continue;
      if (p === dir) continue;
      const rest = p.slice(dir === "/" ? 1 : dir.length + 1);
      const name = rest.split("/")[0]!;
      const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
      if (rest.includes("/")) {
        if (!entries.has(full)) {
          entries.set(full, { path: full, name, type: "dir" });
        }
      } else {
        entries.set(full, {
          path: full,
          name,
          type: "file",
          size: data.byteLength,
        });
      }
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteFile(
    remoteId: string,
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const s = this.require(remoteId);
    const target = normalizePath(path);
    if (target === "/") {
      throw new Error("refusing to delete sandbox root");
    }
    const exact = s.files.has(target);
    const prefix = target + "/";
    const children: string[] = [];
    for (const p of s.files.keys()) {
      if (p.startsWith(prefix)) children.push(p);
    }
    if (!exact && children.length === 0) {
      throw new Error(`ENOENT: ${path}`);
    }
    if (children.length > 0 && !opts?.recursive) {
      throw new Error(`EISDIR: directory not empty (use recursive): ${path}`);
    }
    if (exact) s.files.delete(target);
    for (const p of children) s.files.delete(p);
  }

  async mkdir(
    remoteId: string,
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    const s = this.require(remoteId);
    const target = normalizePath(path);
    if (target === "/") return;
    // 用占位键表示空目录：path/.keep（list 时会显示为 dir）
    const marker = `${target}/.keep`;
    if (s.files.has(target)) {
      throw new Error(`EEXIST: file exists: ${path}`);
    }
    // 已是目录（有子路径）则幂等
    const prefix = target + "/";
    for (const p of s.files.keys()) {
      if (p.startsWith(prefix) || p === marker) return;
    }
    if (opts?.recursive === false) {
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      if (parent !== "/") {
        const parentPrefix = parent + "/";
        let parentOk = false;
        for (const p of s.files.keys()) {
          if (p.startsWith(parentPrefix) || p === parent) {
            parentOk = true;
            break;
          }
        }
        if (!parentOk) {
          throw new Error(`ENOENT: parent missing: ${parent}`);
        }
      }
    }
    s.files.set(marker, new Uint8Array());
  }

  async rename(remoteId: string, from: string, to: string): Promise<void> {
    const s = this.require(remoteId);
    const src = normalizePath(from);
    const dst = normalizePath(to);
    if (src === "/" || dst === "/") {
      throw new Error("refusing to rename sandbox root");
    }
    if (src === dst) return;

    const moves: Array<{ from: string; to: string }> = [];
    if (s.files.has(src)) {
      moves.push({ from: src, to: dst });
    }
    const prefix = src + "/";
    for (const p of s.files.keys()) {
      if (p.startsWith(prefix)) {
        moves.push({ from: p, to: dst + p.slice(src.length) });
      }
    }
    if (moves.length === 0) {
      throw new Error(`ENOENT: ${from}`);
    }
    // 目标冲突：目标路径已有文件且不是本次将搬走的源
    const srcSet = new Set(moves.map((m) => m.from));
    for (const m of moves) {
      if (s.files.has(m.to) && !srcSet.has(m.to)) {
        throw new Error(`EEXIST: ${m.to}`);
      }
    }
    const bufs = moves.map((m) => ({
      to: m.to,
      data: s.files.get(m.from)!,
    }));
    for (const m of moves) s.files.delete(m.from);
    for (const b of bufs) s.files.set(b.to, b.data);
  }

  private require(remoteId: string): FakeState {
    const s = this.sessions.get(remoteId);
    if (!s || s.handle.status === "killed") {
      throw new Error(`sandbox not found: ${remoteId}`);
    }
    return s;
  }
}

function stripQuotes(s: string) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function ok(started: number, stdout: string, stderr: string): CommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr,
    durationMs: Date.now() - started,
  };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
