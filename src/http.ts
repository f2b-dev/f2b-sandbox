import type { ServerResponse } from "node:http";
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

/** 将 AsyncIterable 写成 SSE 到 Node ServerResponse */
export async function writeSse(
  res: ServerResponse,
  events: AsyncIterable<unknown>,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  // 立即 flush 头，避免代理缓冲
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  try {
    for await (const ev of events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    res.write("event: done\ndata: {}\n\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof F2bError ? err.code : "INTERNAL";
    res.write(
      `data: ${JSON.stringify({ type: "error", code, message })}\n\n`,
    );
  } finally {
    res.end();
  }
}
