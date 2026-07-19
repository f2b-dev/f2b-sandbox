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
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

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
  region?: string;
  cpu?: string;
  memory?: string;
}): SandboxRecord {
  const db = getDb();
  const ts = now();
  db.run(
    `INSERT INTO sandboxes (
      id, name, template, status, project_id, backend, remote_id,
      allow_internet, timeout_ms, region, cpu, memory, error,
      created_at, updated_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
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
  const ts = now();
  const db = getDb();

  db.run(
    `UPDATE sandboxes SET status = ?, remote_id = ?, error = ?,
      started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [status, remoteId, error, startedAt, finishedAt, ts, id],
  );
  return getSandboxRow(id);
}

export function recordSandboxUsage(sandboxId: string, durationMs: number) {
  const db = getDb();
  db.run(
    `INSERT INTO sandbox_usage (id, sandbox_id, duration_ms, created_at)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), sandboxId, durationMs, now()],
  );
}
