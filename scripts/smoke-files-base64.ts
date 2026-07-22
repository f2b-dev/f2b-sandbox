/**
 * 文件 base64 读写契约冒烟
 * F2B_SANDBOX_URL 默认 http://127.0.0.1:13287
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:13287";
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function j<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(
      (body as { error?: { message?: string } }).error?.message ||
        res.statusText,
    );
  }
  return body;
}

async function main() {
  const created = await j<{ sandbox: { id: string } }>(
    await fetch(`${base}/v1/sandboxes`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ name: "smoke-files-b64", template: "base" }),
    }),
  );
  const id = created.sandbox.id;
  console.log("created", id);

  try {
    // PNG 头 8 字节
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
    ]);
    const b64 = Buffer.from(bytes).toString("base64");
    const path = "/home/user/bin-smoke.bin";

    await j(
      await fetch(`${base}/v1/sandboxes/${id}/files`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ path, content: b64, encoding: "base64" }),
      }),
    );

    const asB64 = await j<{
      file: { content: string; encoding: string };
    }>(
      await fetch(
        `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent(path)}&encoding=base64`,
        { headers: headers() },
      ),
    );
    if (asB64.file.encoding !== "base64") {
      throw new Error(`expected encoding base64, got ${asB64.file.encoding}`);
    }
    const round = Buffer.from(asB64.file.content, "base64");
    if (!Buffer.from(bytes).equals(round)) {
      throw new Error(
        `roundtrip mismatch: wrote ${b64} read ${asB64.file.content}`,
      );
    }
    console.log("base64 roundtrip ok", round.length, "bytes");

    // utf8 仍可用
    await j(
      await fetch(`${base}/v1/sandboxes/${id}/files`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({
          path: "/home/user/t.txt",
          content: "hello-utf8",
          encoding: "utf8",
        }),
      }),
    );
    const text = await j<{ file: { content: string } }>(
      await fetch(
        `${base}/v1/sandboxes/${id}/files?path=${encodeURIComponent("/home/user/t.txt")}&encoding=utf8`,
        { headers: headers() },
      ),
    );
    if (text.file.content !== "hello-utf8") {
      throw new Error(`utf8 mismatch: ${text.file.content}`);
    }
    console.log("utf8 still ok");

    console.log("SMOKE_FILES_BASE64_OK", id);
  } finally {
    await fetch(`${base}/v1/sandboxes/${id}`, {
      method: "DELETE",
      headers: headers(),
    }).catch(() => null);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
