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

  async runCommand(
    remoteId: string,
    input: RunCommandInput,
  ): Promise<CommandResult> {
    const s = this.require(remoteId);
    return this.exec(s, input);
  }

  async *streamCommand(
    remoteId: string,
    input: RunCommandInput,
  ): AsyncIterable<CommandStreamEvent> {
    const s = this.require(remoteId);
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
