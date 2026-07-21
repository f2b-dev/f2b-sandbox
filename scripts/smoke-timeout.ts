/**
 * 验证 timeoutMs 到期由 reaper 自动 kill。
 * 需服务已启动（默认 reaper 间隔 2s；可用 F2B_TIMEOUT_REAPER_MS=500 加速）。
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

async function main() {
  const createRes = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      name: "timeout-smoke",
      template: "base",
      timeoutMs: 1500,
    }),
  });
  const created = (await createRes.json()) as {
    sandbox?: {
      id: string;
      status: string;
      timeoutMs: number | null;
      error: string | null;
    };
    error?: { message: string };
  };
  if (!createRes.ok || !created.sandbox?.id) {
    console.error("create failed", createRes.status, created);
    process.exit(1);
  }
  const id = created.sandbox.id;
  console.log("created", id, "timeoutMs", created.sandbox.timeoutMs);
  if (created.sandbox.timeoutMs !== 1500) {
    console.error("timeoutMs not persisted", created.sandbox);
    process.exit(1);
  }

  // 最多等 ~8s：timeout 1.5s + reaper 默认 2s 若干轮
  let finalStatus = created.sandbox.status;
  let finalError: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const r = await fetch(`${base}/v1/sandboxes/${id}`, { headers: headers() });
    const body = (await r.json()) as {
      sandbox?: { status: string; error: string | null };
    };
    finalStatus = body.sandbox?.status ?? finalStatus;
    finalError = body.sandbox?.error ?? null;
    console.log(`poll ${i + 1}`, finalStatus, finalError);
    if (finalStatus === "killed") break;
  }

  if (finalStatus !== "killed") {
    console.error("expected killed by reaper, got", finalStatus);
    // 清理，避免占槽
    await fetch(`${base}/v1/sandboxes/${id}`, {
      method: "DELETE",
      headers: headers(),
    });
    process.exit(1);
  }
  if (finalError !== "timeout exceeded") {
    console.error("expected error=timeout exceeded, got", finalError);
    process.exit(1);
  }
  console.log("SMOKE_TIMEOUT_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
