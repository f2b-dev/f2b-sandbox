/**
 * 验证 GET /v1/templates 返回预置目录（至少含 base）。
 */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:13287";
const apiKey = process.env.F2B_API_KEY;

function headers(): Record<string, string> {
  const h: Record<string, string> = {};
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function main() {
  const r = await fetch(`${base}/v1/templates`, { headers: headers() });
  const body = (await r.json()) as {
    templates?: { id: string; name: string; tags?: string[] }[];
    error?: { message: string };
  };
  if (!r.ok) {
    console.error("templates failed", r.status, body);
    process.exit(1);
  }
  const list = body.templates ?? [];
  console.log(
    "templates",
    list.map((t) => t.id),
  );
  if (list.length < 3) {
    console.error("expected at least 3 templates", list.map((t) => t.id));
    process.exit(1);
  }
  for (const id of ["base", "code-interpreter", "browser"]) {
    if (!list.some((t) => t.id === id)) {
      console.error("missing template", id);
      process.exit(1);
    }
  }
  console.log("SMOKE_TEMPLATES_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
