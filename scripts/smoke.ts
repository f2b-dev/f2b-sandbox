const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function main() {
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  console.log("health", health);

  const created = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ name: "smoke", template: "base" }),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j as { sandbox: { id: string } };
  });
  const id = created.sandbox.id;
  console.log("created", id);

  const cmd = await fetch(`${base}/v1/sandboxes/${id}/commands`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ cmd: "echo hello-f2b" }),
  }).then((r) => r.json());
  console.log("command", cmd);

  await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ path: "/home/user/a.txt", content: "ok" }),
  });
  const file = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent("/home/user/a.txt")}`,
    { headers: headers() },
  ).then((r) => r.json());
  console.log("file", file);

  const killed = await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  }).then((r) => r.json());
  console.log("killed", killed);
  console.log("SMOKE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
