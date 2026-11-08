import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReroutingHttpProxy, startScriptedHttpsTarget, readAdminAuth } from "./helpers.mjs";

const SERVER = join(import.meta.dirname, "..", "server.mjs");

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER, "0"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
      const m = /ag-dashboard on http:\/\/0\.0\.0\.0:(\d+)/.exec(out);
      if (m) resolve({ proc, port: Number(m[1]), out: () => out });
    });
    proc.stderr.on("data", (d) => { out += d.toString(); });
    proc.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error("server start timeout: " + out)), 10000);
  });
}

const FREE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeUsageLimitError",
    message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
  },
});

const COUNTRY_BODY = JSON.stringify({
  error: { message: "This model is not available in your country", type: "invalid_request_error" },
});

// Build a pool where the first proxy reaches `bad` and the second reaches `ok`.
//
// The default "bad" answer is the country block, because THAT error is bound
// to the exit IP and therefore the reason for the failover. The free usage
// limit is not: it comes from the shared anonymous pool, so it fails fast
// (see test/oc-proxy-policy.test.mjs).
async function buildPool({ badBody = COUNTRY_BODY, badStatus = 403 } = {}) {
  const badTarget = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(badStatus, { "Content-Type": "application/json" });
    res.end(badBody);
  });
  const okTarget = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "PROXY_OK" } }] }));
  });
  const badProxy = await startReroutingHttpProxy({ upstreamPort: badTarget.port });
  const okProxy = await startReroutingHttpProxy({ upstreamPort: okTarget.port });
  // Every server must be closed, so the file never keeps the event loop busy.
  const close = () => Promise.all([
    badTarget.close(), okTarget.close(), badProxy.close(), okProxy.close(),
  ]);
  return { badTarget, okTarget, badProxy, okProxy, close };
}

async function startFailoverServer(t, pool, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "failover-"));
  const poolFile = join(dir, "proxies.json");
  const quarantineFile = join(dir, "quarantine.json");
  const cfgFile = join(dir, "opencode.jsonc");
  writeFileSync(poolFile, JSON.stringify({ proxies: pool }, null, 2));
  writeFileSync(cfgFile, "{\n  \"provider\": {}\n}\n");
  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: cfgFile,
    AG_PROXY_QUARANTINE_FILE: quarantineFile,
    // The upstream is a local self-signed HTTPS server.
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${pool.upstreamPort}/v1`,
    AG_OC_TARGET_INSECURE: "1",
    ...extraEnv,
  });
  t.after(() => srv.proc.kill("SIGTERM"));
  return { ...srv, poolFile, quarantineFile, dir };
}

function readQuarantine(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")).proxies || {}; } catch { return {}; }
}

test("failover: a poisoned proxy is skipped and the client gets the healthy answer", async (t) => {
  const pool = await buildPool();
  const { badProxy, okProxy, okTarget } = pool;
  t.after(() => pool.close());

  const srv = await startFailoverServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${okProxy.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const res = await fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();

  assert.equal(res.status, 200, "the client must not see the poisoned error: " + text);
  assert.match(text, /PROXY_OK/);
  assert.ok(badProxy.state.connects.length >= 1, "the poisoned proxy was tried first");
  assert.ok(okProxy.state.connects.length >= 1, "the healthy proxy was tried second");
});

test("failover: the poisoned proxy is quarantined and skipped on the next request", async (t) => {
  const pool = await buildPool();
  const { badProxy, okProxy, okTarget } = pool;
  t.after(() => pool.close());

  const srv = await startFailoverServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${okProxy.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const call = () => fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });

  await call();
  const q = readQuarantine(srv.quarantineFile);
  assert.ok(q[`http://127.0.0.1:${badProxy.port}`], "the poisoned proxy must be quarantined: " + JSON.stringify(q));
  assert.ok(q[`http://127.0.0.1:${badProxy.port}`].until > Date.now(), "the quarantine must have a deadline");
  assert.equal(q[`http://127.0.0.1:${okProxy.port}`], undefined, "the healthy proxy must not be quarantined");

  const connectsBefore = badProxy.state.connects.length;
  await call();
  assert.equal(badProxy.state.connects.length, connectsBefore, "the quarantined proxy must not be used again");
});

test("failover: the country block error is treated the same way", async (t) => {
  const pool = await buildPool({
    badBody: COUNTRY_BODY,
    badStatus: 403,
  });
  const { badProxy, okProxy, okTarget } = pool;
  t.after(() => pool.close());

  const srv = await startFailoverServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${okProxy.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const res = await fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m" }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, "the client must not see the country error: " + text);
  const q = readQuarantine(srv.quarantineFile);
  assert.ok(q[`http://127.0.0.1:${badProxy.port}`], "the blocked proxy must be quarantined");
});

test("failover: when every proxy is poisoned the client gets the upstream error", async (t) => {
  const pool = await buildPool();
  const { badTarget, badProxy, okProxy, okTarget } = pool;
  // A second proxy pointing at the same poisoned upstream.
  const badProxy2 = await startReroutingHttpProxy({ upstreamPort: badTarget.port });
  t.after(() => Promise.all([pool.close(), badProxy2.close()]));

  const srv = await startFailoverServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${badProxy2.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const res = await fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m" }),
  });
  const text = await res.text();
  assert.equal(res.status, 403, "the upstream status must be preserved: " + text);
  assert.match(text, /not available in your country/);
});

test("failover: a fully quarantined pool still answers with the upstream error", async (t) => {
  const pool = await buildPool();
  const { badProxy, okTarget } = pool;
  t.after(() => pool.close());

  // A single proxy in the pool, and it is poisoned.
  const srv = await startFailoverServer(t, [`http://127.0.0.1:${badProxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1`,
  });

  const call = () => fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m" }),
  });

  const first = await call();
  assert.equal(first.status, 403, "the first request reports the upstream error: " + await first.text());

  // Now the whole pool is quarantined: the client must still get the real
  // upstream answer instead of a bare 503.
  const second = await call();
  const text = await second.text();
  assert.equal(second.status, 403, "the upstream status must be kept: " + text);
  assert.match(text, /not available in your country/);
});

test("failover: a healthy response is forwarded unchanged", async (t) => {
  const pool = await buildPool();
  const { badProxy, okProxy, okTarget } = pool;
  t.after(() => pool.close());

  const srv = await startFailoverServer(t, [`http://127.0.0.1:${okProxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1`,
  });

  const res = await fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m" }),
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /PROXY_OK/);
  assert.equal(readQuarantine(srv.quarantineFile) && Object.keys(readQuarantine(srv.quarantineFile)).length, 0);
});

test("failover: a streamed answer is not buffered", async (t) => {
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 400);
  });
  const proxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const srv = await startFailoverServer(t, [`http://127.0.0.1:${proxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1`,
  });

  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m", stream: true }),
  });
  const reader = res.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += Buffer.from(chunk.value).toString();
  }
  const totalAt = Date.now() - started;

  assert.equal(res.status, 200);
  assert.match(Buffer.from(first.value).toString(), /one/);
  assert.match(rest, /two/);
  assert.ok(firstAt < 300, "the first chunk must arrive before the stream ends (got " + firstAt + "ms)");
  assert.ok(totalAt >= 400, "the whole stream must still take its time (got " + totalAt + "ms)");
});

test("API: the quarantine list can be read and cleared", async (t) => {
  const pool = await buildPool();
  const { badProxy, okProxy, okTarget } = pool;
  t.after(() => pool.close());

  const srv = await startFailoverServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${okProxy.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const auth = readAdminAuth();
  const headers = { Authorization: "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64") };

  await fetch(`http://127.0.0.1:${srv.port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "m" }),
  });

  const list = await fetch(`http://127.0.0.1:${srv.port}/api/proxies/quarantine`, { headers });
  const listJson = await list.json();
  assert.equal(list.status, 200);
  assert.equal(listJson.count, 1, "one proxy must be quarantined");
  assert.equal(listJson.quarantined.length, 1);
  assert.ok(listJson.quarantined[0].url);
  assert.ok(listJson.quarantined[0].reason);
  assert.ok(listJson.quarantined[0].until > Date.now());

  const cleared = await fetch(`http://127.0.0.1:${srv.port}/api/proxies/quarantine/clear`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({}),
  });
  const clearedJson = await cleared.json();
  assert.equal(cleared.status, 200);
  assert.equal(clearedJson.ok, true);
  assert.equal(clearedJson.cleared, 1);

  const after = await fetch(`http://127.0.0.1:${srv.port}/api/proxies/quarantine`, { headers });
  const afterJson = await after.json();
  assert.equal(afterJson.count, 0, "the quarantine must be empty after clearing");
});
