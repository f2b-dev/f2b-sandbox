/**
 * 活动保活：短 timeout + 中途命令应刷新 lastActiveAt，避免 reaper 误杀。
 * 需 reaper 开启（建议 F2B_TIMEOUT_REAPER_MS=500）。
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:13287";
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function getSb(id: string) {
  const r = await fetch(`${base}/v1/sandboxes/${id}`, { headers: headers() });
  const body = (await r.json()) as {
    sandbox?: {
      status: string;
      error: string | null;
      timeoutMs: number | null;
      lastActiveAt?: string | null;
      startedAt?: string | null;
    };
  };
  if (!r.ok || !body.sandbox) {
    throw new Error(`get failed ${r.status}`);
  }
  return body.sandbox;
}

async function main() {
  // 1) 无活动：应被 reaper 杀掉
  const create1 = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      name: "keepalive-idle",
      template: "base",
      timeoutMs: 1200,
    }),
  });
  const c1 = (await create1.json()) as { sandbox?: { id: string } };
  if (!create1.ok || !c1.sandbox) {
    throw new Error(`create1 failed ${create1.status}`);
  }
  const idleId = c1.sandbox.id;
  console.log("idle", idleId);

  let idleStatus = "running";
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    idleStatus = (await getSb(idleId)).status;
    if (idleStatus === "killed") break;
  }
  if (idleStatus !== "killed") {
    await fetch(`${base}/v1/sandboxes/${idleId}`, {
      method: "DELETE",
      headers: headers(),
    });
    throw new Error(`idle expected killed, got ${idleStatus}`);
  }
  console.log("idle reaped ok");

  // 2) 有活动：中途 run 应保活
  const create2 = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      name: "keepalive-active",
      template: "base",
      timeoutMs: 1500,
    }),
  });
  const c2 = (await create2.json()) as {
    sandbox?: { id: string; lastActiveAt?: string };
  };
  if (!create2.ok || !c2.sandbox) {
    throw new Error(`create2 failed ${create2.status}`);
  }
  const activeId = c2.sandbox.id;
  const before = (await getSb(activeId)).lastActiveAt;
  console.log("active", activeId, "lastActiveAt", before);

  await sleep(800);
  const cmdRes = await fetch(`${base}/v1/sandboxes/${activeId}/commands`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ cmd: "echo keepalive" }),
  });
  if (!cmdRes.ok) {
    throw new Error(`command failed ${cmdRes.status} ${await cmdRes.text()}`);
  }
  const afterCmd = await getSb(activeId);
  if (afterCmd.status !== "running") {
    throw new Error(`expected running after cmd, got ${afterCmd.status}`);
  }
  if (
    before &&
    afterCmd.lastActiveAt &&
    Date.parse(afterCmd.lastActiveAt) <= Date.parse(before)
  ) {
    throw new Error(
      `lastActiveAt not advanced: before=${before} after=${afterCmd.lastActiveAt}`,
    );
  }
  console.log("touched", afterCmd.lastActiveAt);

  // 再等接近原窗口：若仍按 startedAt 计时会挂；滑动后应仍 running
  await sleep(1000);
  const mid = await getSb(activeId);
  if (mid.status !== "running") {
    throw new Error(`expected still running mid-window, got ${mid.status}`);
  }

  // 再等一个完整空闲窗口，应被回收
  let final = mid.status;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    final = (await getSb(activeId)).status;
    if (final === "killed") break;
  }
  if (final !== "killed") {
    await fetch(`${base}/v1/sandboxes/${activeId}`, {
      method: "DELETE",
      headers: headers(),
    });
    throw new Error(`active expected killed after idle, got ${final}`);
  }

  console.log("SMOKE_KEEPALIVE_OK", activeId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
