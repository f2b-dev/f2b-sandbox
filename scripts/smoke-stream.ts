/** SSE 命令流冒烟：create → stream echo → 收齐 stdout/result → kill */
const base = process.env.F2B_SANDBOX_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.F2B_API_KEY;

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function main() {
  const created = await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ name: "stream-smoke", template: "base" }),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j as { sandbox: { id: string } };
  });
  const id = created.sandbox.id;
  console.log("created", id);

  const res = await fetch(`${base}/v1/sandboxes/${id}/commands/stream`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ cmd: "echo stream-ok-from-f2b" }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`stream HTTP ${res.status}`);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream")) {
    throw new Error(`expected event-stream, got ${ctype}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: unknown[] = [];
  let stdout = "";
  let gotResult = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const block of parts) {
      const dataLine = block
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      if (payload === "{}") continue;
      const ev = JSON.parse(payload) as {
        type?: string;
        text?: string;
        result?: { stdout?: string; exitCode?: number };
      };
      events.push(ev);
      if (ev.type === "stdout" && ev.text) stdout += ev.text;
      if (ev.type === "result") gotResult = true;
      if (ev.type === "error") {
        throw new Error(`stream error: ${JSON.stringify(ev)}`);
      }
    }
  }

  if (!gotResult) throw new Error("missing result event");
  if (!stdout.includes("stream-ok-from-f2b")) {
    throw new Error(`stdout missing marker: ${JSON.stringify(stdout)}`);
  }
  if (events.filter((e) => (e as { type?: string }).type === "stdout").length < 1) {
    throw new Error("expected at least one stdout event");
  }

  await fetch(`${base}/v1/sandboxes/${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  console.log("events", events.length, "stdout", JSON.stringify(stdout));
  console.log("STREAM_SMOKE_OK", id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
