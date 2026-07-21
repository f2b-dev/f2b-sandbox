/**
 * 验证 pause / resume：paused 时命令拒绝；resume 后可继续。
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:13287";
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function main() {
  const created = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ name: "pause-smoke", template: "base" }),
  }).then((r) => r.json()) as {
    sandbox?: { id: string; status: string };
    error?: { message: string };
  };
  if (!created.sandbox?.id) {
    console.error("create failed", created);
    process.exit(1);
  }
  const id = created.sandbox.id;
  console.log("created", id);

  const paused = await fetch(`${base}/v1/sandboxes/${id}/pause`, {
    method: "POST",
    headers: headers(),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as {
      sandbox?: { status: string };
      error?: { code: string };
    },
  }));
  if (paused.status !== 200 || paused.body.sandbox?.status !== "paused") {
    console.error("pause failed", paused);
    process.exit(1);
  }
  console.log("paused");

  const cmdWhilePaused = await fetch(`${base}/v1/sandboxes/${id}/commands`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ cmd: "echo should-fail" }),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as { error?: { code: string } },
  }));
  if (
    cmdWhilePaused.status === 200 ||
    cmdWhilePaused.body.error?.code !== "SANDBOX_NOT_RUNNING"
  ) {
    console.error("expected SANDBOX_NOT_RUNNING while paused", cmdWhilePaused);
    process.exit(1);
  }
  console.log("command blocked while paused");

  const resumed = await fetch(`${base}/v1/sandboxes/${id}/resume`, {
    method: "POST",
    headers: headers(),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as { sandbox?: { status: string } },
  }));
  if (resumed.status !== 200 || resumed.body.sandbox?.status !== "running") {
    console.error("resume failed", resumed);
    process.exit(1);
  }
  console.log("resumed");

  const cmd = await fetch(`${base}/v1/sandboxes/${id}/commands`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ cmd: "echo pause-ok" }),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as { result?: { stdout: string } },
  }));
  if (cmd.status !== 200 || !cmd.body.result?.stdout.includes("pause-ok")) {
    console.error("command after resume failed", cmd);
    process.exit(1);
  }

  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  console.log("SMOKE_PAUSE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
