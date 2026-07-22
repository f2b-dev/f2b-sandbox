/**
 * 命令 cwd / env / timeoutMs：fake 语义 + HTTP 契约
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

async function run(
  id: string,
  body: Record<string, unknown>,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const data = await j<{ result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  } }>(
    await fetch(`${base}/v1/sandboxes/${id}/commands`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(body),
    }),
  );
  return data.result;
}

async function main() {
  const created = await j<{ sandbox: { id: string } }>(
    await fetch(`${base}/v1/sandboxes`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ name: "smoke-cmd-opts", template: "base" }),
    }),
  );
  const id = created.sandbox.id;
  console.log("created", id);

  try {
    // cwd
    const pwd = await run(id, { cmd: "pwd", cwd: "/tmp" });
    if (pwd.exitCode !== 0 || !pwd.stdout.includes("/tmp")) {
      throw new Error(`cwd pwd failed: ${JSON.stringify(pwd)}`);
    }
    console.log("cwd ok", pwd.stdout.trim());

    // env
    const envr = await run(id, {
      cmd: "printenv FOO",
      env: { FOO: "bar-cmd" },
    });
    if (envr.exitCode !== 0 || !envr.stdout.includes("bar-cmd")) {
      throw new Error(`env printenv failed: ${JSON.stringify(envr)}`);
    }
    const echoEnv = await run(id, {
      cmd: "echo $FOO",
      env: { FOO: "expanded" },
    });
    if (!echoEnv.stdout.includes("expanded")) {
      throw new Error(`env echo expand failed: ${JSON.stringify(echoEnv)}`);
    }
    console.log("env ok");

    // timeoutMs：sleep 超过窗口 → 124
    const timed = await run(id, {
      cmd: "sleep 5",
      timeoutMs: 200,
    });
    if (timed.exitCode !== 124) {
      throw new Error(`timeout expected 124, got ${JSON.stringify(timed)}`);
    }
    const okSleep = await run(id, {
      cmd: "sleep 0",
      timeoutMs: 2000,
    });
    if (okSleep.exitCode !== 0) {
      throw new Error(`sleep 0 should pass: ${JSON.stringify(okSleep)}`);
    }
    console.log("timeoutMs ok");

    // stream 同样透传 cwd
    const streamRes = await fetch(
      `${base}/v1/sandboxes/${id}/commands/stream`,
      {
        method: "POST",
        headers: {
          ...headers(true),
          accept: "text/event-stream",
        },
        body: JSON.stringify({ cmd: "pwd", cwd: "/var" }),
      },
    );
    if (!streamRes.ok || !streamRes.body) {
      throw new Error(`stream http ${streamRes.status}`);
    }
    const text = await streamRes.text();
    if (!text.includes("/var")) {
      throw new Error(`stream cwd missing /var: ${text.slice(0, 400)}`);
    }
    console.log("stream cwd ok");

    console.log("SMOKE_CMD_OPTS_OK", id);
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
