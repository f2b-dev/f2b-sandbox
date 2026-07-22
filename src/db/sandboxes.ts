import type {
  SandboxBackendKind,
  SandboxRecord,
  SandboxStatus,
} from "@f2b/spec";
import { getDb } from "./client";

type SandboxRow = {
  id: string;
  name: string;
  template: string;
  status: string;
  project_id: string;
  backend: string;
  remote_id: string | null;
  allow_internet: number;
  timeout_ms: number | null;
  region: string;
  cpu: string;
  memory: string;
  error: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function parseMetadata(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function now() {
  return new Date().toISOString();
}

function durationSec(createdAt: string, finishedAt: string | null): number {
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const start = Date.parse(createdAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export function rowToSandboxRecord(row: SandboxRow): SandboxRecord {
  return {
    id: row.id,
    name: row.name,
    template: row.template,
    status: row.status as SandboxStatus,
    projectId: row.project_id,
    backend: row.backend as SandboxBackendKind,
    remoteId: row.remote_id,
    allowInternetAccess: Boolean(row.allow_internet),
    timeoutMs: row.timeout_ms,
    region: row.region,
    cpu: row.cpu,
    memory: row.memory,
    error: row.error,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationSec: durationSec(row.created_at, row.finished_at),
  };
}

export function listSandboxRows(projectId?: string): SandboxRecord[] {
  const db = getDb();
  const rows = projectId
    ? db.all<SandboxRow>(
        `SELECT * FROM sandboxes WHERE project_id = ? ORDER BY created_at DESC LIMIT 200`,
        [projectId],
      )
    : db.all<SandboxRow>(
        `SELECT * FROM sandboxes ORDER BY created_at DESC LIMIT 200`,
      );
  return rows.map(rowToSandboxRecord);
}

/** 占用并发槽位的状态：创建中 / 运行中 / 暂停 */
const ACTIVE_STATUSES = ["provisioning", "running", "paused"] as const;

/** 当前占用并发槽的沙箱数（全机；单节点 all-in-one 硬顶） */
export function countActiveSandboxes(): number {
  const db = getDb();
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sandboxes WHERE status IN (${placeholders})`,
    [...ACTIVE_STATUSES],
  );
  return row?.n ?? 0;
}

/** 带 timeout_ms 的活动沙箱（供到期回收扫表） */
export function listActiveSandboxesWithTimeout(): SandboxRecord[] {
  const db = getDb();
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  const rows = db.all<SandboxRow>(
    `SELECT * FROM sandboxes
     WHERE status IN (${placeholders})
       AND timeout_ms IS NOT NULL
       AND timeout_ms > 0
     ORDER BY created_at ASC
     LIMIT 500`,
    [...ACTIVE_STATUSES],
  );
  return rows.map(rowToSandboxRecord);
}

export function getSandboxRow(id: string): SandboxRecord | null {
  const db = getDb();
  const row = db.get<SandboxRow>(`SELECT * FROM sandboxes WHERE id = ?`, [id]);
  return row ? rowToSandboxRecord(row) : null;
}

export function insertSandbox(input: {
  id: string;
  name: string;
  template: string;
  status: SandboxStatus;
  projectId: string;
  backend: SandboxBackendKind;
  remoteId: string | null;
  allowInternetAccess: boolean;
  timeoutMs: number | null;
  metadata?: Record<string, string>;
  region?: string;
  cpu?: string;
  memory?: string;
}): SandboxRecord {
  const db = getDb();
  const ts = now();
  const metadataJson = JSON.stringify(input.metadata ?? {});
  db.run(
    `INSERT INTO sandboxes (
      id, name, template, status, project_id, backend, remote_id,
      allow_internet, timeout_ms, region, cpu, memory, error, metadata_json,
      created_at, updated_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    [
      input.id,
      input.name,
      input.template,
      input.status,
      input.projectId,
      input.backend,
      input.remoteId,
      input.allowInternetAccess ? 1 : 0,
      input.timeoutMs,
      input.region ?? "cn-hangzhou",
      input.cpu ?? "1 vCPU",
      input.memory ?? "2 GB",
      metadataJson,
      ts,
      ts,
      input.status === "running" ? ts : null,
    ],
  );
  return getSandboxRow(input.id)!;
}

export function updateSandbox(
  id: string,
  patch: {
    status?: SandboxStatus;
    remoteId?: string | null;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    timeoutMs?: number | null;
    metadata?: Record<string, string>;
  },
): SandboxRecord | null {
  const current = getSandboxRow(id);
  if (!current) return null;

  const status = patch.status ?? current.status;
  const remoteId =
    patch.remoteId !== undefined ? patch.remoteId : current.remoteId;
  const error = patch.error !== undefined ? patch.error : current.error;
  const startedAt =
    patch.startedAt !== undefined ? patch.startedAt : current.startedAt;
  const finishedAt =
    patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt;
  const timeoutMs =
    patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs;
  const metadata =
    patch.metadata !== undefined ? patch.metadata : current.metadata;
  const ts = now();
  const db = getDb();

  db.run(
    `UPDATE sandboxes SET status = ?, remote_id = ?, error = ?,
      started_at = ?, finished_at = ?, timeout_ms = ?, metadata_json = ?,
      updated_at = ? WHERE id = ?`,
    [
      status,
      remoteId,
      error,
      startedAt,
      finishedAt,
      timeoutMs,
      JSON.stringify(metadata ?? {}),
      ts,
      id,
    ],
  );
  return getSandboxRow(id);
}

export type UsageKind = "lifetime" | "command";

/** 记一笔用量：lifetime=沙箱存活时长；command=命令次数（duration 可为 0） */
export function recordSandboxUsage(
  sandboxId: string,
  durationMs: number,
  opts?: { commands?: number; kind?: UsageKind },
) {
  const db = getDb();
  const commands = opts?.commands ?? 0;
  const kind = opts?.kind ?? (commands > 0 ? "command" : "lifetime");
  db.run(
    `INSERT INTO sandbox_usage (id, sandbox_id, duration_ms, commands, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), sandboxId, durationMs, commands, kind, now()],
  );
}

export type UsageDayBucket = {
  day: string;
  sandboxHours: number;
  commands: number;
  durationMs: number;
};

export type UsageSummary = {
  days: number;
  totalDurationMs: number;
  totalSandboxHours: number;
  totalCommands: number;
  byDay: UsageDayBucket[];
};

/** 按 UTC 日期聚合近 N 天用量（含无数据日补 0） */
export function summarizeUsage(days = 7): UsageSummary {
  const n = Math.min(90, Math.max(1, Math.floor(days)));
  const db = getDb();
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (n - 1));
  const sinceIso = since.toISOString();

  const rows = db.all<{
    day: string;
    duration_ms: number | bigint;
    commands: number | bigint;
  }>(
    `SELECT substr(created_at, 1, 10) AS day,
            COALESCE(SUM(duration_ms), 0) AS duration_ms,
            COALESCE(SUM(commands), 0) AS commands
     FROM sandbox_usage
     WHERE created_at >= ?
     GROUP BY substr(created_at, 1, 10)
     ORDER BY day ASC`,
    [sinceIso],
  );

  const map = new Map<string, { durationMs: number; commands: number }>();
  for (const r of rows) {
    map.set(r.day, {
      durationMs: Number(r.duration_ms),
      commands: Number(r.commands),
    });
  }

  const byDay: UsageDayBucket[] = [];
  let totalDurationMs = 0;
  let totalCommands = 0;
  for (let i = 0; i < n; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    const hit = map.get(day) ?? { durationMs: 0, commands: 0 };
    totalDurationMs += hit.durationMs;
    totalCommands += hit.commands;
    byDay.push({
      day,
      durationMs: hit.durationMs,
      sandboxHours: hit.durationMs / 3_600_000,
      commands: hit.commands,
    });
  }

  return {
    days: n,
    totalDurationMs,
    totalSandboxHours: totalDurationMs / 3_600_000,
    totalCommands,
    byDay,
  };
}
