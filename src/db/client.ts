import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

function resolveDbPath() {
  const raw = process.env.DATABASE_URL ?? "file:./data/f2b-sandbox.db";
  const filePath = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export class F2bDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  all<T extends Row = Row>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  get<T extends Row = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params) as T | undefined;
  }

  run(sql: string, params: SqlValue[] = []) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }
}

let _db: F2bDb | null = null;

export function getDb(): F2bDb {
  if (_db) return _db;
  _db = new F2bDb(resolveDbPath());
  return _db;
}

export function resolveDatabasePath() {
  return resolveDbPath();
}
