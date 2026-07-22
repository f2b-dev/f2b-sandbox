/**
 * 文件 mkdir + rename：建目录 → 写文件 → 重命名 → 读新路径 → 旧路径 404。
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
    body: JSON.stringify({ name: "files-mkdir-rename", template: "base" }),
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

  const dir = "/home/user/workdir";
  const mkdirRes = await fetch(`${base}/v1/sandboxes/${id}/files/mkdir`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ path: dir, recursive: true }),
  });
  const mkdirBody = (await mkdirRes.json()) as {
    ok?: boolean;
    path?: string;
    error?: { message?: string };
  };
  if (!mkdirRes.ok || !mkdirBody.ok) {
    throw new Error(
      `mkdir failed: ${mkdirRes.status} ${JSON.stringify(mkdirBody)}`,
    );
  }
  console.log("mkdir", mkdirBody.path);

  const from = `${dir}/note.txt`;
  const to = `${dir}/note-renamed.txt`;
  await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      path: from,
      content: "mkdir-rename-ok",
      encoding: "utf8",
    }),
  });

  const renameRes = await fetch(`${base}/v1/sandboxes/${id}/files/rename`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ from, to }),
  });
  const renameBody = (await renameRes.json()) as {
    ok?: boolean;
    from?: string;
    to?: string;
    error?: { message?: string };
  };
  if (!renameRes.ok || !renameBody.ok) {
    throw new Error(
      `rename failed: ${renameRes.status} ${JSON.stringify(renameBody)}`,
    );
  }
  console.log("renamed", renameBody.from, "->", renameBody.to);

  const readNew = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent(to)}&encoding=utf8`,
    { headers: headers() },
  );
  const readNewBody = (await readNew.json()) as {
    file?: { content?: string };
  };
  if (!readNew.ok || readNewBody.file?.content !== "mkdir-rename-ok") {
    throw new Error(
      `read renamed failed: ${readNew.status} ${JSON.stringify(readNewBody)}`,
    );
  }

  const readOld = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent(from)}&encoding=utf8`,
    { headers: headers() },
  );
  if (readOld.status !== 404) {
    throw new Error(`expected 404 on old path, got ${readOld.status}`);
  }

  // 目录重命名
  const treeFrom = "/home/user/tree-a";
  const treeTo = "/home/user/tree-b";
  await fetch(`${base}/v1/sandboxes/${id}/files/mkdir`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ path: treeFrom }),
  });
  await fetch(`${base}/v1/sandboxes/${id}/files`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      path: `${treeFrom}/child.txt`,
      content: "child",
      encoding: "utf8",
    }),
  });
  const dirRename = await fetch(`${base}/v1/sandboxes/${id}/files/rename`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ from: treeFrom, to: treeTo }),
  });
  if (!dirRename.ok) {
    throw new Error(
      `dir rename failed: ${dirRename.status} ${await dirRename.text()}`,
    );
  }
  const child = await fetch(
    `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent(`${treeTo}/child.txt`)}&encoding=utf8`,
    { headers: headers() },
  );
  const childBody = (await child.json()) as { file?: { content?: string } };
  if (!child.ok || childBody.file?.content !== "child") {
    throw new Error(`dir rename content missing: ${JSON.stringify(childBody)}`);
  }

  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  console.log("SMOKE_FILES_MKDIR_RENAME_OK", id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
