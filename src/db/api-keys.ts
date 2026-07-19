import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./client";

export type ApiKeyRecord = {
  id: string;
  name: string;
  keyPrefix: string;
  projectId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  project_id: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    projectId: row.project_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** SHA-256 hex；只存 hash，明文不入库 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** 生成 sk_live_… 明文（仅创建响应返回一次） */
export function generateApiKeyPlaintext(): {
  plaintext: string;
  prefix: string;
  hash: string;
} {
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `sk_live_${secret}`;
  const prefix = plaintext.slice(0, 12);
  return { plaintext, prefix, hash: hashApiKey(plaintext) };
}

function newId() {
  return `key_${randomBytes(8).toString("hex")}`;
}

export function createApiKey(input: {
  name: string;
  projectId?: string;
}): { record: ApiKeyRecord; plaintext: string } {
  const db = getDb();
  const { plaintext, prefix, hash } = generateApiKeyPlaintext();
  const id = newId();
  const now = new Date().toISOString();
  const projectId = input.projectId?.trim() || "default";
  const name = input.name.trim() || "default";

  db.run(
    `INSERT INTO api_keys (id, name, key_prefix, key_hash, project_id, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [id, name, prefix, hash, projectId, now],
  );

  return {
    plaintext,
    record: {
      id,
      name,
      keyPrefix: prefix,
      projectId,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

export function listApiKeys(projectId?: string): ApiKeyRecord[] {
  const db = getDb();
  const rows = projectId
    ? db.all<ApiKeyRow>(
        `SELECT * FROM api_keys WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
        [projectId],
      )
    : db.all<ApiKeyRow>(
        `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`,
      );
  return rows.map(rowToRecord);
}

export function revokeApiKey(id: string): ApiKeyRecord | null {
  const db = getDb();
  const row = db.get<ApiKeyRow>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
  if (!row) return null;
  if (row.revoked_at) return rowToRecord(row);
  const now = new Date().toISOString();
  db.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`, [now, id]);
  return rowToRecord({ ...row, revoked_at: now });
}

/**
 * 用明文密钥查找未吊销记录。
 * 比较 hash 使用 timing-safe（同长度 hex）。
 */
export function findApiKeyByPlaintext(
  plaintext: string,
): ApiKeyRecord | null {
  if (!plaintext || plaintext.length < 16) return null;
  const hash = hashApiKey(plaintext);
  const db = getDb();
  const row = db.get<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    [hash],
  );
  if (!row) {
    // 假比较，降低计时侧信道差异（无记录时）
    const dummy = createHash("sha256").update("x").digest("hex");
    try {
      timingSafeEqual(Buffer.from(hash), Buffer.from(dummy));
    } catch {
      /* length mismatch impossible for sha256 hex */
    }
    return null;
  }
  const a = Buffer.from(hash);
  const b = Buffer.from(row.key_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const now = new Date().toISOString();
  db.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [now, row.id]);
  return rowToRecord({ ...row, last_used_at: now });
}
