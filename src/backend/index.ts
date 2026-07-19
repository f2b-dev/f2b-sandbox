import { CubeSandboxBackend } from "./cube-backend";
import { FakeSandboxBackend } from "./fake-backend";
import type { SandboxBackend } from "./types";

export type {
  SandboxBackend,
  BackendSandboxHandle,
  CreateSandboxBackendRequest,
} from "./types";
export { FakeSandboxBackend } from "./fake-backend";
export { CubeSandboxBackend } from "./cube-backend";

const BACKEND_KEY = "__f2b_sandbox_backend__";

function envGet(env: NodeJS.ProcessEnv, ...keys: string[]) {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * 解析数据面：F2B_SANDBOX_BACKEND=fake 强制 Fake；
 * 配置 F2B_CUBE_API_URL / CUBE_API_URL 则走生产集群客户端，否则 Fake。
 */
export function createSandboxBackend(
  env: NodeJS.ProcessEnv = process.env,
): SandboxBackend {
  const g = globalThis as typeof globalThis & {
    [BACKEND_KEY]?: SandboxBackend;
  };
  if (g[BACKEND_KEY]) return g[BACKEND_KEY];

  const force = (
    env.F2B_SANDBOX_BACKEND ?? env.SANDBOX_BACKEND ?? ""
  ).toLowerCase();
  let backend: SandboxBackend;
  if (force === "fake") {
    backend = new FakeSandboxBackend();
  } else {
    const baseUrl = envGet(env, "F2B_CUBE_API_URL", "CUBE_API_URL");
    if (baseUrl) {
      backend = new CubeSandboxBackend({
        baseUrl,
        token: envGet(env, "F2B_CUBE_API_TOKEN", "CUBE_API_TOKEN"),
      });
    } else {
      backend = new FakeSandboxBackend();
    }
  }
  g[BACKEND_KEY] = backend;
  return backend;
}

export function resetSandboxBackendSingleton() {
  const g = globalThis as typeof globalThis & {
    [BACKEND_KEY]?: SandboxBackend;
  };
  delete g[BACKEND_KEY];
}
