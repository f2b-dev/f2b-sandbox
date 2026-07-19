import { F2bError } from "@f2b/spec";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function jsonError(err: unknown): Response {
  if (err instanceof F2bError) {
    return json({ error: err.toJSON() }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: { code: "INTERNAL", message } }, 500);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
