import {
  CreateSandboxSchema,
  ErrorCode,
  F2bError,
  ReadFileQuerySchema,
  RunCommandSchema,
  WriteFileSchema,
  type CommandStreamEvent,
  type CreateSandboxInput,
  type SandboxRecord,
  type SandboxStatus,
} from "@f2b/spec";
import {
  getSandboxRow,
  insertSandbox,
  listSandboxRows,
  recordSandboxUsage,
  updateSandbox,
} from "./db/sandboxes";
import {
  createSandboxBackend,
  resetSandboxBackendSingleton,
  type SandboxBackend,
} from "./backend";

function getBackend(): SandboxBackend {
  return createSandboxBackend();
}

export function resetSandboxBackendForTests() {
  resetSandboxBackendSingleton();
}

const TERMINAL: SandboxStatus[] = ["killed", "failed", "succeeded"];

function assertRunning(sb: SandboxRecord) {
  if (TERMINAL.includes(sb.status)) {
    throw new F2bError(
      ErrorCode.SANDBOX_ALREADY_TERMINAL,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  if (sb.status !== "running" && sb.status !== "paused") {
    throw new F2bError(
      ErrorCode.SANDBOX_NOT_RUNNING,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  if (!sb.remoteId) {
    throw new F2bError(
      ErrorCode.SANDBOX_NOT_RUNNING,
      `sandbox ${sb.id} has no remote id`,
    );
  }
}

export async function listSandboxes(projectId?: string): Promise<SandboxRecord[]> {
  return listSandboxRows(projectId);
}

export async function getSandbox(id: string): Promise<SandboxRecord> {
  const row = getSandboxRow(id);
  if (!row) {
    throw new F2bError(ErrorCode.SANDBOX_NOT_FOUND, `sandbox not found: ${id}`);
  }
  return row;
}

export async function createSandbox(raw: unknown): Promise<SandboxRecord> {
  const parsed = CreateSandboxSchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid create payload", {
      details: parsed.error.flatten(),
    });
  }
  const input: CreateSandboxInput = parsed.data;
  const id = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const name = input.name?.trim() || `sandbox-${id.slice(4, 10)}`;

  insertSandbox({
    id,
    name,
    template: input.template,
    status: "provisioning",
    projectId: input.projectId,
    backend: getBackend().kind,
    remoteId: null,
    allowInternetAccess: input.allowInternetAccess,
    timeoutMs: input.timeoutMs ?? null,
  });

  try {
    const handle = await getBackend().create({
      ...input,
      sandboxId: id,
      name,
    });
    const updated = updateSandbox(id, {
      status: handle.status === "provisioning" ? "running" : handle.status,
      remoteId: handle.remoteId,
      startedAt: new Date().toISOString(),
      error: null,
    });
    return updated!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateSandbox(id, {
      status: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
    });
    throw err instanceof F2bError
      ? err
      : new F2bError(ErrorCode.BACKEND_UNAVAILABLE, message, { cause: err });
  }
}

export async function killSandbox(id: string): Promise<SandboxRecord> {
  const sb = await getSandbox(id);
  if (TERMINAL.includes(sb.status)) {
    return sb;
  }
  if (sb.remoteId) {
    try {
      await getBackend().kill(sb.remoteId);
    } catch {
      // 远端已不存在仍标记本地 killed
    }
  }
  const started = sb.startedAt
    ? Date.parse(sb.startedAt)
    : Date.parse(sb.createdAt);
  const durationMs = Math.max(
    0,
    Date.now() - (Number.isNaN(started) ? Date.now() : started),
  );
  recordSandboxUsage(id, durationMs);
  return updateSandbox(id, {
    status: "killed",
    finishedAt: new Date().toISOString(),
    error: null,
  })!;
}

export async function runSandboxCommand(id: string, raw: unknown) {
  const sb = await getSandbox(id);
  assertRunning(sb);
  const parsed = RunCommandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid command payload", {
      details: parsed.error.flatten(),
    });
  }
  try {
    return await getBackend().runCommand(sb.remoteId!, parsed.data);
  } catch (err) {
    if (err instanceof F2bError) throw err;
    throw new F2bError(
      ErrorCode.COMMAND_FAILED,
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
}

/** 流式命令：优先 backend.streamCommand，否则把整包结果拆成事件 */
export async function* streamSandboxCommand(
  id: string,
  raw: unknown,
): AsyncGenerator<CommandStreamEvent, void, unknown> {
  const sb = await getSandbox(id);
  assertRunning(sb);
  const parsed = RunCommandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid command payload", {
      details: parsed.error.flatten(),
    });
  }
  const backend = getBackend();
  try {
    if (backend.streamCommand) {
      for await (const ev of backend.streamCommand(sb.remoteId!, parsed.data)) {
        yield ev;
      }
      return;
    }
    const result = await backend.runCommand(sb.remoteId!, parsed.data);
    if (result.stdout) yield { type: "stdout", text: result.stdout };
    if (result.stderr) yield { type: "stderr", text: result.stderr };
    yield { type: "result", result };
  } catch (err) {
    if (err instanceof F2bError) {
      yield {
        type: "error",
        code: err.code,
        message: err.message,
      };
      return;
    }
    yield {
      type: "error",
      code: ErrorCode.COMMAND_FAILED,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function writeSandboxFile(id: string, raw: unknown) {
  const sb = await getSandbox(id);
  assertRunning(sb);
  const parsed = WriteFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid write payload", {
      details: parsed.error.flatten(),
    });
  }
  const path = sanitizePath(parsed.data.path);
  const content =
    parsed.data.encoding === "base64"
      ? Buffer.from(parsed.data.content, "base64")
      : parsed.data.content;
  await getBackend().writeFile(sb.remoteId!, path, content);
  return { path, ok: true as const };
}

export async function readSandboxFile(id: string, raw: unknown) {
  const sb = await getSandbox(id);
  assertRunning(sb);
  const parsed = ReadFileQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid read query", {
      details: parsed.error.flatten(),
    });
  }
  const path = sanitizePath(parsed.data.path);
  try {
    const data = await getBackend().readFile(sb.remoteId!, path);
    if (parsed.data.encoding === "base64") {
      return {
        path,
        encoding: "base64" as const,
        content: Buffer.from(data).toString("base64"),
      };
    }
    return {
      path,
      encoding: "utf8" as const,
      content: Buffer.from(data).toString("utf8"),
    };
  } catch (err) {
    throw new F2bError(
      ErrorCode.NOT_FOUND,
      err instanceof Error ? err.message : `file not found: ${path}`,
      { status: 404, cause: err },
    );
  }
}

export async function listSandboxFiles(id: string, path = "/home/user") {
  const sb = await getSandbox(id);
  assertRunning(sb);
  const safe = sanitizePath(path);
  return getBackend().listFiles(sb.remoteId!, safe);
}

function sanitizePath(p: string): string {
  if (!p || p.includes("\0")) {
    throw new F2bError(ErrorCode.INVALID_PATH, "invalid path");
  }
  if (!p.startsWith("/")) {
    throw new F2bError(
      ErrorCode.INVALID_PATH,
      "path must be absolute inside sandbox",
    );
  }
  const parts = p.split("/").filter((s) => s && s !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length === 0) {
        throw new F2bError(ErrorCode.INVALID_PATH, "path escapes root");
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return "/" + stack.join("/");
}
