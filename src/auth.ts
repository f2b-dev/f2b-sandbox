import { ErrorCode, F2bError } from "@f2b/spec";
import { findApiKeyByPlaintext, type ApiKeyRecord } from "./db/api-keys";

export type AuthMode = "off" | "api_key";

export type AuthContext = {
  mode: AuthMode;
  /** 校验通过的密钥元数据；mode=off 时为 null */
  apiKey: ApiKeyRecord | null;
};

/** F2B_AUTH_MODE=off|api_key；默认 off 方便本地与 BFF 内网 */
export function resolveAuthMode(): AuthMode {
  const raw = (process.env.F2B_AUTH_MODE ?? "off").toLowerCase().trim();
  if (raw === "api_key" || raw === "apikey" || raw === "key") return "api_key";
  return "off";
}

/**
 * 从请求提取 API Key：
 * - Authorization: Bearer sk_live_…
 * - X-API-Key: sk_live_…
 */
export function extractApiKey(req: Request): string | null {
  const x = req.headers.get("x-api-key")?.trim();
  if (x) return x;
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

export function authenticateRequest(req: Request): AuthContext {
  const mode = resolveAuthMode();
  if (mode === "off") {
    return { mode, apiKey: null };
  }

  const plaintext = extractApiKey(req);
  if (!plaintext) {
    throw new F2bError(ErrorCode.UNAUTHORIZED, "missing API key", {
      details: {
        hint: "Authorization: Bearer <key> or X-API-Key header",
      },
    });
  }

  const record = findApiKeyByPlaintext(plaintext);
  if (!record) {
    throw new F2bError(ErrorCode.UNAUTHORIZED, "invalid API key");
  }

  return { mode, apiKey: record };
}

/** 管理密钥端点：创建/列表/吊销 — 始终需要 F2B_ADMIN_TOKEN（若配置）或与 api_key 模式共用 */
export function assertAdmin(req: Request): void {
  const admin = process.env.F2B_ADMIN_TOKEN?.trim();
  if (!admin) {
    // 未配置管理令牌：仅允许 auth=off 的本地开发创建密钥
    if (resolveAuthMode() === "off") return;
    throw new F2bError(
      ErrorCode.UNAUTHORIZED,
      "F2B_ADMIN_TOKEN required for key management when auth is on",
    );
  }
  const provided =
    req.headers.get("x-f2b-admin-token")?.trim() ||
    extractApiKey(req);
  if (!provided || provided !== admin) {
    throw new F2bError(ErrorCode.UNAUTHORIZED, "invalid admin token");
  }
}
