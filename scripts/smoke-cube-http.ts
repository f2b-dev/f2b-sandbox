/**
 * 经产品 HTTP `/v1` 验收 cube 数据面（mock 或真集群）。
 * 需已启动：sandbox backend=cube + 可达 CubeAPI/envd。
 */
const base = (process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:13287").replace(
  /\/$/,
  "",
);
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function main() {
  const hzRes = await fetch(`${base}/healthz`);
  const hz = (await hzRes.json()) as { backend?: string; ok?: boolean };
  if (!hzRes.ok || !hz.ok) {
    throw new Error(`healthz failed: ${hzRes.status} ${JSON.stringify(hz)}`);
  }
  if (hz.backend !== "cube") {
    throw new Error(
      `expected healthz.backend=cube, got ${JSON.stringify(hz.backend)} — 请配置 F2B_CUBE_API_URL 且勿强制 fake`,
    );
  }
  console.log("healthz backend=cube");

  const createRes = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      name: "smoke-cube-http",
      template: "base",
      timeoutMs: 120_000,
    }),
  });
  const created = (await createRes.json()) as {
    sandbox?: { id: string; status: string };
    error?: { message?: string };
  };
  if (!createRes.ok || !created.sandbox?.id) {
    throw new Error(
      `create failed: ${createRes.status} ${created.error?.message ?? JSON.stringify(created)}`,
    );
  }
  const id = created.sandbox.id;
  console.log("created", id, created.sandbox.status);

  const cmdRes = await fetch(`${base}/v1/sandboxes/${id}/commands`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ cmd: "echo cube-http-ok" }),
  });
  const cmd = (await cmdRes.json()) as {
    result?: { exitCode: number; stdout: string };
    error?: { message?: string };
  };
  if (
    !cmdRes.ok ||
    cmd.result?.exitCode !== 0 ||
    !String(cmd.result?.stdout ?? "").includes("cube-http-ok")
  ) {
    throw new Error(`command failed: ${JSON.stringify(cmd)}`);
  }
  console.log("command ok");

  const writeRes = await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      path: "/home/user/http.txt",
      content: "via-v1",
      encoding: "utf8",
    }),
  });
  if (!writeRes.ok) {
    throw new Error(`write failed: ${writeRes.status} ${await writeRes.text()}`);
  }
  const readRes = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent("/home/user/http.txt")}`,
    { headers: headers() },
  );
  const readBody = (await readRes.json()) as {
    file?: { content?: string };
    content?: string;
  };
  const content = readBody.file?.content ?? readBody.content ?? "";
  if (!readRes.ok || content !== "via-v1") {
    throw new Error(`read failed: ${JSON.stringify(readBody)}`);
  }
  console.log("files ok");

  const killRes = await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  const killed = (await killRes.json()) as {
    sandbox?: { status: string };
  };
  if (!killRes.ok || killed.sandbox?.status !== "killed") {
    throw new Error(`kill failed: ${JSON.stringify(killed)}`);
  }
  console.log("kill ok");
  console.log("SMOKE_CUBE_HTTP_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
