/**
 * 直连 CubeSandboxBackend（mock CubeAPI + mock envd），不经 HTTP 服务层。
 * 校验：create 字段、envd 命令 Connect、文件读写、kill。
 */
import { CubeSandboxBackend } from "../src/backend/cube-backend";
import { resetSandboxBackendSingleton } from "../src/backend";

const cubeUrl =
  process.env.F2B_CUBE_API_URL ?? "http://127.0.0.1:18991";
const envdUrl =
  process.env.F2B_CUBE_ENVD_BASE_URL ?? "http://127.0.0.1:18992";

async function main() {
  resetSandboxBackendSingleton();
  const backend = new CubeSandboxBackend({
    baseUrl: cubeUrl,
    token: process.env.F2B_CUBE_API_TOKEN ?? "mock-token",
    envdBaseUrl: envdUrl,
  });

  if (backend.kind !== "cube") {
    throw new Error(`expected kind=cube, got ${backend.kind}`);
  }

  const localId = `sbx_smoke_${Date.now()}`;
  const created = await backend.create({
    sandboxId: localId,
    template: "base",
    name: "smoke-cube",
    allowInternetAccess: false,
  });
  console.log("create", {
    remoteId: created.remoteId,
    status: created.status,
    hasToken: Boolean(created.envd?.envdAccessToken),
    domain: created.envd?.domain,
  });
  if (!created.remoteId) throw new Error("missing remoteId");
  if (!created.envd?.envdAccessToken) {
    throw new Error("create response missing envdAccessToken");
  }

  const got = await backend.get(created.remoteId);
  if (!got || got.remoteId !== created.remoteId) {
    throw new Error("get mismatch");
  }
  console.log("get ok", got.status);

  const cmd = await backend.runCommand(created.remoteId, {
    cmd: "echo hello-cube-envd",
  });
  console.log("command", cmd);
  if (cmd.exitCode !== 0) throw new Error(`exit ${cmd.exitCode}`);
  if (!cmd.stdout.includes("hello-cube-envd")) {
    throw new Error(`unexpected stdout: ${cmd.stdout}`);
  }

  await backend.writeFile(created.remoteId, "/home/user/a.txt", "phase-c-ok");
  const bytes = await backend.readFile(created.remoteId, "/home/user/a.txt");
  const text = new TextDecoder().decode(bytes);
  console.log("file", text);
  if (text !== "phase-c-ok") throw new Error(`file content: ${text}`);

  const listing = await backend.listFiles(created.remoteId, "/home/user");
  console.log(
    "list",
    listing.map((e) => e.name),
  );
  if (!listing.some((e) => e.name === "a.txt" && e.type === "file")) {
    throw new Error("listFiles missing a.txt");
  }

  await backend.kill(created.remoteId);
  const after = await backend.get(created.remoteId);
  if (after) throw new Error("expected null after kill");
  console.log("kill ok");
  console.log("SMOKE_CUBE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
