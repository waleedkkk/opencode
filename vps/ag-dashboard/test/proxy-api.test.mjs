import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = join(import.meta.dirname, "..", "server.mjs");
import { readAdminAuth } from "./helpers.mjs";

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

async function call(port, method, path, body, auth = "admin") {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

test("API: full pool check reports status, results and can prune failures", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "poolapi-"));
  const poolFile = join(dir, "proxies.json");
  const cfgFile = join(dir, "opencode.jsonc");
  // Two entries: one real loopback proxy that works, one guaranteed-dead port.
  writeFileSync(poolFile, JSON.stringify({ proxies: ["http://127.0.0.1:9", "http://127.0.0.1:1"] }, null, 2));
  writeFileSync(cfgFile, "{\n  \"provider\": {}\n}\n");

  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: cfgFile,
    AG_PROXY_CHECK_HOST: "127.0.0.1",
    AG_PROXY_CHECK_PORT: "9",
    AG_PROXY_CHECK_PATH: "/",
    AG_PROXY_CHECK_INSECURE: "1",
    AG_PROXY_CHECK_TIMEOUT: "2000",
  });
  t.after(() => srv.proc.kill("SIGTERM"));

  const auth = readAdminAuth();

  // Start the job.
  const start = await call(srv.port, "POST", "/api/proxies/test-all", {}, auth);
  assert.equal(start.status, 200);
  assert.equal(start.json.started, true);
  assert.ok(start.json.total >= 2, "expected total >= 2, got " + JSON.stringify(start.json));

  // Poll until finished.
  let status = null;
  for (let i = 0; i < 60; i++) {
    const r = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
    assert.equal(r.status, 200);
    status = r.json;
    if (!status.running) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  assert.ok(status, "no status");
  assert.equal(status.running, false);
  assert.equal(status.tested, status.total);
  assert.equal(status.failed.length, status.total, "both dead proxies should fail: " + JSON.stringify(status));

  // Prune removes the failures from the pool file.
  const prune = await call(srv.port, "POST", "/api/proxies/prune", {}, auth);
  assert.equal(prune.status, 200);
  assert.ok(prune.json.ok, JSON.stringify(prune.json));
  const after = JSON.parse(readFileSync(poolFile, "utf8"));
  assert.equal(after.proxies.length, 0, "all failed proxies should be gone");
  assert.ok(prune.json.backup, "expected a backup path");
  assert.ok(existsSync(prune.json.backup), "backup file must exist: " + prune.json.backup);
  const backups = readdirSync(dir).filter((f) => f.includes("bak"));
  assert.ok(backups.length >= 1, "expected a .bak file in " + dir);
});

test("API: guest role cannot run pool operations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "poolapi2-"));
  const poolFile = join(dir, "proxies.json");
  writeFileSync(poolFile, JSON.stringify({ proxies: [] }, null, 2));
  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: join(dir, "opencode.jsonc"),
  });
  t.after(() => srv.proc.kill("SIGTERM"));

  const guest = { user: "user", pass: "123456" };
  const r = await call(srv.port, "POST", "/api/proxies/test-all", {}, guest);
  assert.equal(r.status, 403);
});

test("API: the dashboard survives a pool check against hostile proxies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "poolapi3-"));
  const poolFile = join(dir, "proxies.json");
  const cfgFile = join(dir, "opencode.jsonc");
  // A mix of dead ports and a proxy that resets the connection mid-handshake.
  const hostile = [];
  for (let i = 0; i < 12; i++) hostile.push(`http://127.0.0.1:${9 + i}`);
  writeFileSync(poolFile, JSON.stringify({ proxies: hostile }, null, 2));
  writeFileSync(cfgFile, "{\n  \"provider\": {}\n}\n");

  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: cfgFile,
    AG_PROXY_CHECK_HOST: "api.ipify.org",
    AG_PROXY_CHECK_PORT: "443",
    AG_PROXY_CHECK_TIMEOUT: "1500",
  });
  t.after(() => srv.proc.kill("SIGTERM"));

  const auth = readAdminAuth();
  await call(srv.port, "POST", "/api/proxies/test-all", {}, auth);

  let status = null;
  for (let i = 0; i < 60; i++) {
    const r = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
    assert.equal(r.status, 200, "server must stay up and answer");
    status = r.json;
    if (!status.running) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.ok(status && !status.running, "check must finish");
  assert.equal(status.tested, 12);
  assert.equal(status.failed.length, 12, "all dead proxies must fail");
});

test("API: the finished check stays readable for the dashboard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "poolapi4-"));
  const poolFile = join(dir, "proxies.json");
  writeFileSync(poolFile, JSON.stringify({ proxies: ["http://127.0.0.1:9"] }, null, 2));
  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: join(dir, "opencode.jsonc"),
    AG_PROXY_CHECK_HOST: "api.ipify.org",
    AG_PROXY_CHECK_PORT: "443",
    AG_PROXY_CHECK_TIMEOUT: "1500",
  });
  t.after(() => srv.proc.kill("SIGTERM"));
  const auth = readAdminAuth();

  await call(srv.port, "POST", "/api/proxies/test-all", {}, auth);
  for (let i = 0; i < 40; i++) {
    const r = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
    if (!r.json.running) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  // A later page load must still see the finished result.
  const again = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
  assert.equal(again.status, 200);
  assert.equal(again.json.running, false);
  assert.equal(again.json.total, 1);
  assert.equal(again.json.tested, 1);
  assert.equal(again.json.failed.length, 1);
  assert.ok(again.json.failed[0].url, "the failed proxy must be identified");
});

test("API: pruning twice is safe and the stale failure list is cleared", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "poolapi5-"));
  const poolFile = join(dir, "proxies.json");
  const cfgFile = join(dir, "opencode.jsonc");
  writeFileSync(poolFile, JSON.stringify({ proxies: ["http://127.0.0.1:9", "http://127.0.0.1:10"] }, null, 2));
  writeFileSync(cfgFile, "{\n  \"provider\": {}\n}\n");

  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: cfgFile,
    AG_PROXY_CHECK_HOST: "api.ipify.org",
    AG_PROXY_CHECK_PORT: "443",
    AG_PROXY_CHECK_TIMEOUT: "1500",
  });
  t.after(() => srv.proc.kill("SIGTERM"));
  const auth = readAdminAuth();

  await call(srv.port, "POST", "/api/proxies/test-all", {}, auth);
  for (let i = 0; i < 40; i++) {
    const r = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
    if (!r.json.running) break;
    await new Promise((res) => setTimeout(res, 200));
  }

  // First prune removes the failures.
  const first = await call(srv.port, "POST", "/api/proxies/prune", {}, auth);
  assert.equal(first.status, 200, "first prune must succeed: " + JSON.stringify(first.json));
  assert.equal(first.json.removed, 2);
  assert.equal(JSON.parse(readFileSync(poolFile, "utf8")).proxies.length, 0);

  // The status must no longer advertise the removed failures, otherwise a
  // page reload would show them again and offer to delete them once more.
  const after = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
  assert.equal(after.json.failed.length, 0, "failed list must be cleared after pruning");
  assert.equal(after.json.pruned, true, "status must record that the pool was pruned");

  // Second prune must not fail — it is a no-op, not an error.
  const second = await call(srv.port, "POST", "/api/proxies/prune", {}, auth);
  assert.equal(second.status, 200, "second prune must not error: " + JSON.stringify(second.json));
  assert.equal(second.json.ok, true);
  assert.equal(second.json.removed, 0);
});

test("API: failures that were already removed are not listed again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "poolapi6-"));
  const poolFile = join(dir, "proxies.json");
  writeFileSync(poolFile, JSON.stringify({ proxies: ["http://127.0.0.1:9"] }, null, 2));
  const srv = await startServer({
    AG_PROXY_POOL_FILE: poolFile,
    AG_OPENCODE_CONFIG: join(dir, "opencode.jsonc"),
    AG_PROXY_CHECK_HOST: "api.ipify.org",
    AG_PROXY_CHECK_PORT: "443",
    AG_PROXY_CHECK_TIMEOUT: "1500",
  });
  t.after(() => srv.proc.kill("SIGTERM"));
  const auth = readAdminAuth();

  await call(srv.port, "POST", "/api/proxies/test-all", {}, auth);
  for (let i = 0; i < 40; i++) {
    const r = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
    if (!r.json.running) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.equal((await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth)).json.failed.length, 1);

  // The proxy disappears from the pool (deleted elsewhere).
  writeFileSync(poolFile, JSON.stringify({ proxies: [] }, null, 2));

  const st = await call(srv.port, "GET", "/api/proxies/test-all/status", null, auth);
  assert.equal(st.json.failed.length, 0, "removed proxy must not be listed as failed");
  assert.equal(st.json.pruned, true, "status must report the pool as already cleaned");
});
