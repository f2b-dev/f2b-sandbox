import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SQL = `
CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT 'default',
  backend TEXT NOT NULL,
  remote_id TEXT,
  allow_internet INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  region TEXT NOT NULL DEFAULT 'cn-hangzhou',
  cpu TEXT NOT NULL DEFAULT '1 vCPU',
  memory TEXT NOT NULL DEFAULT '2 GB',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS sandbox_usage (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`;

function resolveDbPath() {
  const raw = process.env.DATABASE_URL ?? "file:./data/f2b-sandbox.db";
  const filePath = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(SQL);
db.close();
console.log(`Migrated database at ${dbPath}`);
