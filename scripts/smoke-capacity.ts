/**
 * 验证 F2B_MAX_CONCURRENT_SANDBOXES 硬顶：
 * 在 limit=1 时第二路 create 应返回 CAPACITY_EXCEEDED (429)。
 * 需外部已启动服务，或本脚本自启临时实例。
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function create(name: string) {
  const r = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ name, template: "base" }),
  });
  const body = (await r.json()) as {
    sandbox?: { id: string };
    error?: { code: string; message: string; details?: unknown };
  };
  return { status: r.status, body };
}

async function kill(id: string) {
  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
}

async function main() {
  const health = (await fetch(`${base}/healthz`).then((r) => r.json())) as {
    maxConcurrentSandboxes?: number;
  };
  console.log("health", health);

  if (health.maxConcurrentSandboxes == null) {
    console.error(
      "需要 F2B_MAX_CONCURRENT_SANDBOXES>0 的实例（healthz 应含 maxConcurrentSandboxes）",
    );
    process.exit(1);
  }

  const first = await create("cap-1");
  if (first.status !== 200 && first.status !== 201) {
    // 服务可能已有残留 active；尽量清掉再试一次
    console.error("first create failed", first);
    process.exit(1);
  }
  const id1 = first.body.sandbox!.id;
  console.log("created first", id1);

  const second = await create("cap-2");
  if (second.status !== 429 || second.body.error?.code !== "CAPACITY_EXCEEDED") {
    await kill(id1);
    console.error("expected CAPACITY_EXCEEDED 429, got", second);
    process.exit(1);
  }
  console.log("second blocked", second.body.error);

  await kill(id1);
  const third = await create("cap-3");
  if (!third.body.sandbox?.id) {
    console.error("create after kill should succeed", third);
    process.exit(1);
  }
  console.log("created after free", third.body.sandbox.id);
  await kill(third.body.sandbox.id);
  console.log("SMOKE_CAPACITY_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
