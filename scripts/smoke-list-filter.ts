/**
 * 列表 status 过滤：创建 running → filter running 命中 → kill → filter killed 命中。
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
  const createRes = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ name: "list-filter-smoke", template: "base" }),
  });
  const created = (await createRes.json()) as {
    sandbox?: { id: string; status: string };
    error?: { message?: string };
  };
  if (!createRes.ok || !created.sandbox) {
    throw new Error(`create failed: ${JSON.stringify(created)}`);
  }
  const id = created.sandbox.id;

  const runList = await fetch(`${base}/v1/sandboxes?status=running`, {
    headers: headers(),
  });
  const runBody = (await runList.json()) as {
    sandboxes?: Array<{ id: string }>;
  };
  if (!runList.ok || !runBody.sandboxes?.some((s) => s.id === id)) {
    throw new Error(`running filter miss: ${JSON.stringify(runBody)}`);
  }

  const bad = await fetch(`${base}/v1/sandboxes?status=not-a-status`, {
    headers: headers(),
  });
  if (bad.status !== 400) {
    throw new Error(`expected 400 for bad status, got ${bad.status}`);
  }

  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });

  const killedList = await fetch(`${base}/v1/sandboxes?status=killed`, {
    headers: headers(),
  });
  const killedBody = (await killedList.json()) as {
    sandboxes?: Array<{ id: string }>;
  };
  if (!killedList.ok || !killedBody.sandboxes?.some((s) => s.id === id)) {
    throw new Error(`killed filter miss: ${JSON.stringify(killedBody)}`);
  }

  const multi = await fetch(
    `${base}/v1/sandboxes?status=${encodeURIComponent("running,killed")}`,
    { headers: headers() },
  );
  const multiBody = (await multi.json()) as {
    sandboxes?: Array<{ id: string }>;
  };
  if (!multi.ok || !multiBody.sandboxes?.some((s) => s.id === id)) {
    throw new Error(`multi status filter miss: ${JSON.stringify(multiBody)}`);
  }

  console.log("SMOKE_LIST_FILTER_OK", id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
