// Server-level tests for the opencode.ai proxy path.
//
// These drive the real dashboard over HTTP with a fake upstream, so they
// check what the client actually receives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReroutingHttpProxy, startScriptedHttpsTarget } from "./helpers.mjs";

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

function readQuarantine(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")).proxies || {}; } catch { return {}; }
}

async function startProxyServer(t, pool, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocpolicy-"));
  const poolFile = join(dir, "proxies.json");
  const quarantineFile = join(dir, "quarantine.json");
  const cfgFile = join(dir, "opencode.jsonc");
  writeFileSync(poolFile, JSON.stringify({ proxies: pool }, null, 2));
  writeFileSync(cfgFile, '{\n  "provider": {}\n}\n');
  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: cfgFile,
    AG_PROXY_QUARANTINE_FILE: quarantineFile,
    AG_OC_TARGET_INSECURE: "1",
    ...extraEnv,
  });
  t.after(() => srv.proc.kill("SIGTERM"));
  return { ...srv, poolFile, quarantineFile, dir };
}

function post(port, body = { model: "m" }, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/opencode-proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", connection: "close", ...headers },
    body: JSON.stringify(body),
  });
}

test("a shared-pool 429 fails fast: the client sees the upstream error and no proxy is quarantined", async (t) => {
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "retry-after": "48069" });
    res.end(FREE_LIMIT_BODY);
  });
  const proxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const srv = await startProxyServer(t, [`http://127.0.0.1:${proxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1`,
  });

  const res = await post(srv.port);
  const text = await res.text();

  assert.equal(res.status, 429, "the client must see the upstream status: " + text);
  assert.match(text, /FreeUsageLimitError/);
  assert.equal(res.headers.get("retry-after"), "48069", "the retry-after must reach the client");
  assert.equal(
    Object.keys(readQuarantine(srv.quarantineFile)).length, 0,
    "a shared-pool limit must not park the exit IP",
  );
});

test("a shared-pool 429 does not burn the other proxies", async (t) => {
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(FREE_LIMIT_BODY);
  });
  const proxy1 = await startReroutingHttpProxy({ upstreamPort: target.port });
  const proxy2 = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), proxy1.close(), proxy2.close()]));

  const srv = await startProxyServer(t, [
    `http://127.0.0.1:${proxy1.port}`,
    `http://127.0.0.1:${proxy2.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1` });

  const res = await post(srv.port);
  assert.equal(res.status, 429);

  const used = proxy1.state.connects.length + proxy2.state.connects.length;
  assert.equal(used, 1, "the request must stop at the first proxy, not walk the whole pool");
});

test("a country block still quarantines the exit IP and tries the next proxy", async (t) => {
  const badTarget = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(COUNTRY_BODY);
  });
  const okTarget = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "PROXY_OK" } }] }));
  });
  const badProxy = await startReroutingHttpProxy({ upstreamPort: badTarget.port });
  const okProxy = await startReroutingHttpProxy({ upstreamPort: okTarget.port });
  t.after(() => Promise.all([badTarget.close(), okTarget.close(), badProxy.close(), okProxy.close()]));

  const srv = await startProxyServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${okProxy.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const res = await post(srv.port);
  const text = await res.text();

  assert.equal(res.status, 200, "the client must not see the country error: " + text);
  assert.match(text, /PROXY_OK/);
  const q = readQuarantine(srv.quarantineFile);
  assert.ok(q[`http://127.0.0.1:${badProxy.port}`], "the blocked exit IP must be quarantined");
  assert.equal(q[`http://127.0.0.1:${okProxy.port}`], undefined, "the healthy proxy must not be quarantined");
});

test("a personal key never travels through an untrusted proxy", async (t) => {
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "PROXY_OK" } }] }));
  });
  const anonProxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  const trustedProxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), anonProxy.close(), trustedProxy.close()]));

  const srv = await startProxyServer(t, [
    `http://127.0.0.1:${anonProxy.port}`,
    `http://127.0.0.1:${trustedProxy.port}`,
  ], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1`,
    // The trusted set is narrowed to the second proxy only.
    AG_OC_TRUSTED_PROXY_HOSTS: "127.0.0.1",
    AG_OC_TRUSTED_PROXY_ENTRIES: `127.0.0.1:${trustedProxy.port}`,
  });

  const res = await post(srv.port, { model: "m" }, { authorization: "Bearer sk-personal-secret" });
  const text = await res.text();

  assert.equal(res.status, 200, "the request must succeed: " + text);
  assert.equal(anonProxy.state.connects.length, 0, "the anonymous proxy must not see a personal key");
  assert.ok(trustedProxy.state.connects.length >= 1, "the trusted proxy must carry the request");
});

test("a personal key with no trusted proxy fails without touching any proxy", async (t) => {
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const anonProxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), anonProxy.close()]));

  const srv = await startProxyServer(t, [`http://127.0.0.1:${anonProxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1`,
    AG_OC_TRUSTED_PROXY_HOSTS: "trusted.example",
  });

  const res = await post(srv.port, { model: "m" }, { authorization: "Bearer sk-personal-secret" });
  const text = await res.text();

  assert.equal(res.status, 503, "the request must not go out without a trusted proxy: " + text);
  assert.equal(anonProxy.state.connects.length, 0, "no proxy may see the personal key");
});

test("the anonymous shared pool still uses the whole pool", async (t) => {
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "PROXY_OK" } }] }));
  });
  const proxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const srv = await startProxyServer(t, [`http://127.0.0.1:${proxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1`,
    AG_OC_TRUSTED_PROXY_HOSTS: "trusted.example",
  });

  const res = await post(srv.port, { model: "m" }, { authorization: "Bearer public" });
  assert.equal(res.status, 200);
  assert.ok(proxy.state.connects.length >= 1, "the anonymous pool may use any proxy");
});

test("a zstd compressed country block is still detected and the proxy is quarantined", async (t) => {
  const zlib = await import("node:zlib");
  const compressed = zlib.zstdCompressSync(Buffer.from(COUNTRY_BODY));
  const badTarget = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(403, { "Content-Type": "application/json", "content-encoding": "zstd" });
    res.end(compressed);
  });
  const okTarget = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "PROXY_OK" } }] }));
  });
  const badProxy = await startReroutingHttpProxy({ upstreamPort: badTarget.port });
  const okProxy = await startReroutingHttpProxy({ upstreamPort: okTarget.port });
  t.after(() => Promise.all([badTarget.close(), okTarget.close(), badProxy.close(), okProxy.close()]));

  const srv = await startProxyServer(t, [
    `http://127.0.0.1:${badProxy.port}`,
    `http://127.0.0.1:${okProxy.port}`,
  ], { AG_OC_INFERENCE_BASE: `https://127.0.0.1:${okTarget.port}/v1` });

  const res = await post(srv.port);
  const text = await res.text();

  assert.equal(res.status, 200, "the compressed country error must still be seen: " + text);
  assert.match(text, /PROXY_OK/);
  const q = readQuarantine(srv.quarantineFile);
  assert.ok(q[`http://127.0.0.1:${badProxy.port}`], "the blocked exit IP must be quarantined");
});

test("a zstd compressed free limit is still recognised as a shared-pool limit", async (t) => {
  const zlib = await import("node:zlib");
  const compressed = zlib.zstdCompressSync(Buffer.from(FREE_LIMIT_BODY));
  const target = await startScriptedHttpsTarget((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "content-encoding": "zstd", "retry-after": "120" });
    res.end(compressed);
  });
  const proxy = await startReroutingHttpProxy({ upstreamPort: target.port });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const srv = await startProxyServer(t, [`http://127.0.0.1:${proxy.port}`], {
    AG_OC_INFERENCE_BASE: `https://127.0.0.1:${target.port}/v1`,
  });

  const res = await post(srv.port);
  await res.text();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "120");
  assert.equal(Object.keys(readQuarantine(srv.quarantineFile)).length, 0, "no quarantine for a shared pool");
});
