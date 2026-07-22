import {
  BUILTIN_TEMPLATES,
  CreateSandboxSchema,
  ErrorCode,
  F2bError,
  ReadFileQuerySchema,
  RunCommandSchema,
  UpdateSandboxSchema,
  WriteFileSchema,
  type CommandStreamEvent,
  type CreateSandboxInput,
  type SandboxRecord,
  type SandboxStatus,
  type TemplateRef,
  type UpdateSandboxInput,
} from "@f2b/spec";
import {
  countActiveSandboxes,
  getSandboxRow,
  insertSandbox,
  listActiveSandboxesWithTimeout,
  listSandboxRows,
  recordSandboxUsage,
  summarizeUsage,
  updateSandbox,
  type UsageSummary,
} from "./db/sandboxes";
import {
  createSandboxBackend,
  resetSandboxBackendSingleton,
  type SandboxBackend,
} from "./backend";

function getBackend(): SandboxBackend {
  return createSandboxBackend();
}

/**
 * 单机并发硬顶。未设置或 ≤0 表示不限制（开发默认）。
 * 与 capacity 文档分档对齐，例如低配入门 2、推荐入门 5。
 */
export function resolveMaxConcurrentSandboxes(): number | null {
  const raw = process.env.F2B_MAX_CONCURRENT_SANDBOXES?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function assertCapacityAvailable() {
  const max = resolveMaxConcurrentSandboxes();
  if (max === null) return;
  const active = countActiveSandboxes();
  if (active >= max) {
    throw new F2bError(
      ErrorCode.CAPACITY_EXCEEDED,
      `concurrent sandbox limit reached (${active}/${max})`,
      {
        status: 429,
        details: { active, max },
      },
    );
  }
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
  // 命令/文件仅允许 running；paused 需先 resume
  if (sb.status !== "running") {
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

/**
 * 更新活动沙箱：延期 timeoutMs（从 startedAt 起算）与/或浅合并 metadata。
 * 终态沙箱拒绝修改。
 */
export async function updateSandboxFields(
  id: string,
  raw: unknown,
): Promise<SandboxRecord> {
  const parsed = UpdateSandboxSchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid update payload", {
      details: parsed.error.flatten(),
    });
  }
  const input: UpdateSandboxInput = parsed.data;
  const sb = await getSandbox(id);
  if (TERMINAL.includes(sb.status)) {
    throw new F2bError(
      ErrorCode.SANDBOX_ALREADY_TERMINAL,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  const patch: {
    timeoutMs?: number | null;
    metadata?: Record<string, string>;
  } = {};
  if (input.timeoutMs !== undefined) {
    patch.timeoutMs = input.timeoutMs;
  }
  if (input.metadata !== undefined) {
    patch.metadata = { ...sb.metadata, ...input.metadata };
  }
  const updated = updateSandbox(id, patch);
  if (!updated) {
    throw new F2bError(ErrorCode.SANDBOX_NOT_FOUND, `sandbox not found: ${id}`);
  }
  return updated;
}

export async function createSandbox(raw: unknown): Promise<SandboxRecord> {
  const parsed = CreateSandboxSchema.safeParse(raw);
  if (!parsed.success) {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "invalid create payload", {
      details: parsed.error.flatten(),
    });
  }
  // 在写入 provisioning 行之前检查，避免失败行占槽
  assertCapacityAvailable();
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
    metadata: input.metadata ?? {},
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

export async function pauseSandbox(id: string): Promise<SandboxRecord> {
  const sb = await getSandbox(id);
  if (TERMINAL.includes(sb.status)) {
    throw new F2bError(
      ErrorCode.SANDBOX_ALREADY_TERMINAL,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  if (sb.status === "paused") return sb;
  if (sb.status !== "running" || !sb.remoteId) {
    throw new F2bError(
      ErrorCode.SANDBOX_NOT_RUNNING,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  const backend = getBackend();
  if (!backend.pause) {
    throw new F2bError(
      ErrorCode.BACKEND_UNAVAILABLE,
      `pause not supported by backend ${backend.kind}`,
      { status: 501 },
    );
  }
  try {
    await backend.pause(sb.remoteId);
  } catch (err) {
    throw err instanceof F2bError
      ? err
      : new F2bError(
          ErrorCode.BACKEND_UNAVAILABLE,
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
  }
  return updateSandbox(id, { status: "paused", error: null })!;
}

export async function resumeSandbox(id: string): Promise<SandboxRecord> {
  const sb = await getSandbox(id);
  if (TERMINAL.includes(sb.status)) {
    throw new F2bError(
      ErrorCode.SANDBOX_ALREADY_TERMINAL,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  if (sb.status === "running") return sb;
  if (sb.status !== "paused" || !sb.remoteId) {
    throw new F2bError(
      ErrorCode.SANDBOX_NOT_RUNNING,
      `sandbox ${sb.id} is ${sb.status}`,
    );
  }
  const backend = getBackend();
  if (!backend.resume) {
    throw new F2bError(
      ErrorCode.BACKEND_UNAVAILABLE,
      `resume not supported by backend ${backend.kind}`,
      { status: 501 },
    );
  }
  try {
    await backend.resume(sb.remoteId);
  } catch (err) {
    throw err instanceof F2bError
      ? err
      : new F2bError(
          ErrorCode.BACKEND_UNAVAILABLE,
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
  }
  return updateSandbox(id, { status: "running", error: null })!;
}

export async function killSandbox(
  id: string,
  opts?: { reason?: string },
): Promise<SandboxRecord> {
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
    error: opts?.reason ?? null,
  })!;
}

/** 扫表回收 timeoutMs 已到期的活动沙箱；返回被 kill 的 id 列表 */
export async function reapExpiredSandboxes(
  nowMs = Date.now(),
): Promise<string[]> {
  const candidates = listActiveSandboxesWithTimeout();
  const killed: string[] = [];
  for (const sb of candidates) {
    if (sb.timeoutMs == null || sb.timeoutMs <= 0) continue;
    const start = Date.parse(sb.startedAt ?? sb.createdAt);
    if (Number.isNaN(start)) continue;
    if (nowMs < start + sb.timeoutMs) continue;
    try {
      await killSandbox(sb.id, { reason: "timeout exceeded" });
      killed.push(sb.id);
    } catch (err) {
      console.error(
        `[reaper] failed to kill ${sb.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return killed;
}

/**
 * 启动周期回收器。
 * F2B_TIMEOUT_REAPER_MS：扫描间隔，默认 2000；≤0 关闭。
 */
export function startTimeoutReaper(): { stop: () => void } | null {
  const raw = process.env.F2B_TIMEOUT_REAPER_MS?.trim();
  const intervalMs = raw === undefined || raw === "" ? 2000 : Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.log("[reaper] disabled (F2B_TIMEOUT_REAPER_MS<=0)");
    return null;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const ids = await reapExpiredSandboxes();
      if (ids.length) {
        console.log(`[reaper] killed ${ids.length}: ${ids.join(", ")}`);
      }
    } catch (err) {
      console.error(
        "[reaper] tick error:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      running = false;
    }
  };
  // 启动立即扫一次（重启后清遗留超时实例）
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  console.log(`[reaper] started intervalMs=${intervalMs}`);
  return {
    stop: () => clearInterval(handle),
  };
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
    const result = await getBackend().runCommand(sb.remoteId!, parsed.data);
    recordSandboxUsage(id, result.durationMs ?? 0, {
      commands: 1,
      kind: "command",
    });
    return result;
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
  let counted = false;
  const countOnce = (durationMs = 0) => {
    if (counted) return;
    counted = true;
    recordSandboxUsage(id, durationMs, { commands: 1, kind: "command" });
  };
  try {
    if (backend.streamCommand) {
      for await (const ev of backend.streamCommand(sb.remoteId!, parsed.data)) {
        if (ev.type === "result") {
          countOnce(ev.result?.durationMs ?? 0);
        }
        yield ev;
      }
      countOnce(0);
      return;
    }
    const result = await backend.runCommand(sb.remoteId!, parsed.data);
    countOnce(result.durationMs ?? 0);
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

export function getUsageSummary(days = 7): UsageSummary {
  return summarizeUsage(days);
}

/** 预置模板目录（与 @f2b/spec BUILTIN_TEMPLATES 同源） */
export function listTemplates(): TemplateRef[] {
  return BUILTIN_TEMPLATES.map((t) => ({
    ...t,
    tags: [...t.tags],
  }));
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

export async function deleteSandboxFile(
  id: string,
  raw: { path?: string; recursive?: boolean },
) {
  const sb = await getSandbox(id);
  assertRunning(sb);
  const pathRaw = raw.path;
  if (!pathRaw || typeof pathRaw !== "string") {
    throw new F2bError(ErrorCode.VALIDATION_ERROR, "path query required");
  }
  const path = sanitizePath(pathRaw);
  if (path === "/") {
    throw new F2bError(ErrorCode.INVALID_PATH, "refusing to delete root");
  }
  try {
    await getBackend().deleteFile(sb.remoteId!, path, {
      recursive: Boolean(raw.recursive),
    });
  } catch (err) {
    if (err instanceof F2bError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      throw new F2bError(ErrorCode.NOT_FOUND, msg, { status: 404, cause: err });
    }
    if (/EISDIR|not empty|recursive/i.test(msg)) {
      throw new F2bError(ErrorCode.VALIDATION_ERROR, msg, { cause: err });
    }
    throw new F2bError(ErrorCode.BACKEND_UNAVAILABLE, msg, { cause: err });
  }
  return { path, ok: true as const };
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
