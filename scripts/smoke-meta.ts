/**
 * metadata 持久化 + PATCH 延期 timeout / 合并 metadata。
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
    body: JSON.stringify({
      name: "meta-smoke",
      template: "base",
      timeoutMs: 60_000,
      metadata: { owner: "ci", env: "smoke" },
    }),
  });
  const created = (await createRes.json()) as {
    sandbox?: {
      id: string;
      timeoutMs: number | null;
      metadata?: Record<string, string>;
      status: string;
    };
    error?: { message: string };
  };
  if (!createRes.ok || !created.sandbox?.id) {
    console.error("create failed", createRes.status, created);
    process.exit(1);
  }
  const id = created.sandbox.id;
  console.log("created", id, created.sandbox.metadata);

  if (created.sandbox.metadata?.owner !== "ci") {
    console.error("metadata not persisted on create", created.sandbox);
    process.exit(1);
  }
  if (created.sandbox.timeoutMs !== 60_000) {
    console.error("timeoutMs mismatch", created.sandbox.timeoutMs);
    process.exit(1);
  }

  const patchRes = await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify({
      timeoutMs: 120_000,
      metadata: { env: "patched", job: "j1" },
    }),
  });
  const patched = (await patchRes.json()) as {
    sandbox?: {
      timeoutMs: number | null;
      metadata?: Record<string, string>;
    };
    error?: { message: string };
  };
  if (!patchRes.ok || !patched.sandbox) {
    console.error("patch failed", patchRes.status, patched);
    process.exit(1);
  }
  if (patched.sandbox.timeoutMs !== 120_000) {
    console.error("timeout not extended", patched.sandbox);
    process.exit(1);
  }
  const md = patched.sandbox.metadata ?? {};
  if (md.owner !== "ci" || md.env !== "patched" || md.job !== "j1") {
    console.error("metadata merge failed", md);
    process.exit(1);
  }
  console.log("patched", md, "timeoutMs", patched.sandbox.timeoutMs);

  const getRes = await fetch(`${base}/v1/sandboxes/${id}`, {
    headers: headers(),
  });
  const got = (await getRes.json()) as {
    sandbox?: { metadata?: Record<string, string>; timeoutMs: number | null };
  };
  if (got.sandbox?.timeoutMs !== 120_000 || got.sandbox?.metadata?.job !== "j1") {
    console.error("get after patch mismatch", got);
    process.exit(1);
  }

  // 终态后 PATCH 应拒绝
  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  const afterKill = await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify({ timeoutMs: 999 }),
  });
  const afterBody = (await afterKill.json()) as {
    error?: { code?: string };
  };
  if (afterKill.ok || afterBody.error?.code !== "SANDBOX_ALREADY_TERMINAL") {
    console.error("expected SANDBOX_ALREADY_TERMINAL after kill", afterKill.status, afterBody);
    process.exit(1);
  }

  console.log("SMOKE_META_OK", id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
