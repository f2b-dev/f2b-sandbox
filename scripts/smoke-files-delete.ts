/**
 * 文件删除：write → delete → 404 read；目录 recursive。
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
    body: JSON.stringify({ name: "files-del-smoke", template: "base" }),
  });
  const created = (await createRes.json()) as {
    sandbox?: { id: string };
    error?: { message?: string };
  };
  if (!createRes.ok || !created.sandbox) {
    throw new Error(
      `create failed: ${createRes.status} ${created.error?.message ?? ""}`,
    );
  }
  const id = created.sandbox.id;
  console.log("created", id);

  const path = "/home/user/del-me.txt";
  await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ path, content: "bye", encoding: "utf8" }),
  });

  const delRes = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE", headers: headers() },
  );
  const delBody = (await delRes.json()) as {
    ok?: boolean;
    path?: string;
    error?: { code?: string; message?: string };
  };
  if (!delRes.ok || !delBody.ok) {
    throw new Error(
      `delete failed: ${delRes.status} ${JSON.stringify(delBody)}`,
    );
  }
  console.log("deleted", delBody.path);

  const readRes = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent(path)}&encoding=utf8`,
    { headers: headers() },
  );
  if (readRes.status !== 404) {
    throw new Error(`expected 404 after delete, got ${readRes.status}`);
  }

  // 目录：两个文件 + recursive
  await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      path: "/home/user/tree/a.txt",
      content: "a",
      encoding: "utf8",
    }),
  });
  await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      path: "/home/user/tree/b.txt",
      content: "b",
      encoding: "utf8",
    }),
  });
  const nonRec = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent("/home/user/tree")}`,
    { method: "DELETE", headers: headers() },
  );
  if (nonRec.ok) {
    throw new Error("expected non-recursive dir delete to fail");
  }
  const recRes = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent("/home/user/tree")}&recursive=1`,
    { method: "DELETE", headers: headers() },
  );
  const recBody = await recRes.json();
  if (!recRes.ok) {
    throw new Error(`recursive delete failed: ${JSON.stringify(recBody)}`);
  }

  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  console.log("SMOKE_FILES_DELETE_OK", id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
