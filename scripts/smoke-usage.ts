/**
 * 用量聚合冒烟：创建 → 命令 → 销毁 → GET /v1/usage 应有 commands≥1 与时长。
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:13287";

async function main() {
  const health = await (await fetch(`${base}/healthz`)).json();
  console.log("health", health);

  const created = await (
    await fetch(`${base}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "usage-smoke", template: "base" }),
    })
  ).json();
  const id = created.sandbox?.id as string;
  if (!id) throw new Error(`create failed: ${JSON.stringify(created)}`);
  console.log("created", id);

  const cmd = await (
    await fetch(`${base}/v1/sandboxes/${id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "echo usage-ok" }),
    })
  ).json();
  console.log("command", cmd.result?.stdout?.trim());

  await fetch(`${base}/v1/sandboxes/${id}`, { method: "DELETE" });

  const usageRes = await fetch(`${base}/v1/usage?days=7`);
  const usageBody = await usageRes.json();
  if (!usageRes.ok) {
    throw new Error(`usage failed: ${JSON.stringify(usageBody)}`);
  }
  const u = usageBody.usage as {
    totalCommands: number;
    totalDurationMs: number;
    byDay: { day: string; commands: number; durationMs: number }[];
  };
  console.log("usage", {
    totalCommands: u.totalCommands,
    totalDurationMs: u.totalDurationMs,
    days: u.byDay?.length,
  });
  if (u.totalCommands < 1) {
    throw new Error("expected totalCommands >= 1 after command");
  }
  if (u.totalDurationMs < 0) {
    throw new Error("expected non-negative duration");
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayBucket = u.byDay?.find((d) => d.day === today);
  if (!todayBucket || todayBucket.commands < 1) {
    throw new Error(`today bucket missing commands: ${JSON.stringify(todayBucket)}`);
  }
  console.log("SMOKE_USAGE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
