/**
 * 鉴权冒烟：开启 F2B_AUTH_MODE=api_key 的服务上
 * create key → 无密钥 401 → 有密钥 create/kill → 吊销后 401
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:8787";
const admin = process.env.F2B_ADMIN_TOKEN;

function adminHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (admin) h["x-f2b-admin-token"] = admin;
  return h;
}

async function main() {
  const health = (await fetch(`${base}/healthz`).then((r) => r.json())) as {
    auth?: string;
  };
  if (health.auth !== "api_key") {
    throw new Error(
      `expected auth=api_key, got ${JSON.stringify(health)} — start with F2B_AUTH_MODE=api_key F2B_ADMIN_TOKEN=…`,
    );
  }

  const createdKey = await fetch(`${base}/v1/api-keys`, {
    method: "POST",
    headers: adminHeaders(true),
    body: JSON.stringify({ name: "smoke-auth" }),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(`create key: ${JSON.stringify(j)}`);
    return j as { key: { id: string; keyPrefix: string }; secret: string };
  });

  if (!createdKey.secret?.startsWith("sk_live_")) {
    throw new Error("secret missing or bad prefix");
  }
  if (JSON.stringify(createdKey).includes(createdKey.secret) === false) {
    throw new Error("secret should appear once in create response");
  }
  console.log("key created", createdKey.key.id, createdKey.key.keyPrefix);

  const noAuth = await fetch(`${base}/v1/sandboxes`, { method: "GET" });
  if (noAuth.status !== 401) {
    throw new Error(`expected 401 without key, got ${noAuth.status}`);
  }
  console.log("no-key → 401 ok");

  const withKey = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${createdKey.secret}`,
    },
    body: JSON.stringify({ name: "auth-smoke", template: "base" }),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j as { sandbox: { id: string } };
  });
  console.log("create with key", withKey.sandbox.id);

  await fetch(`${base}/v1/sandboxes/${withKey.sandbox.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${createdKey.secret}` },
  });

  const list = await fetch(`${base}/v1/api-keys`, {
    headers: adminHeaders(),
  }).then((r) => r.json());
  const listed = JSON.stringify(list);
  if (listed.includes(createdKey.secret)) {
    throw new Error("plaintext secret leaked in list response");
  }
  console.log("list has no plaintext ok");

  await fetch(`${base}/v1/api-keys/${createdKey.key.id}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });

  const afterRevoke = await fetch(`${base}/v1/sandboxes`, {
    headers: { authorization: `Bearer ${createdKey.secret}` },
  });
  if (afterRevoke.status !== 401) {
    throw new Error(`expected 401 after revoke, got ${afterRevoke.status}`);
  }
  console.log("revoked → 401 ok");
  console.log("AUTH_SMOKE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
