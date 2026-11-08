// ag-dashboard: companion web UI for opencode-ag-auth account management.
// - Lists accounts + per-account quota (same mechanics as the plugin).
// - Guides OAuth login in the phone browser (manual callback paste).
// No npm dependencies. Run: node server.mjs [port]

import http, { createServer } from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmdirSync, copyFileSync, unlinkSync, appendFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { openProxyTunnel, testProxy } from "./proxy-tunnel.mjs";
import {
  readState as readOcContainerProxy,
  enable as enableOcContainerProxy,
  disable as disableOcContainerProxy,
  rollback as rollbackOcContainerProxy,
} from "./oc-container-proxy.mjs";
import { loadIdentity, identityHeaders, createIdentityWatcher } from "/root/.config/opencode/antigravity-identity.mjs";
import { checkPool, pruneFailed } from "./proxy-pool.mjs";
import { createQuarantineStore, DEFAULT_QUARANTINE_TTL_MS } from "./proxy-failover.mjs";
import { classifyUpstream, isPersonalKeyRequest, selectProxiesForRequest } from "./proxy-policy.mjs";

const PORT = Number(process.argv[2] || 8899);
const TOKEN_FILE = "/root/.local/share/opencode/ag-dashboard-token";
let TOKEN = "";
try { TOKEN = readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
if (!/^[0-9a-f]{32}$/.test(TOKEN)) {
  TOKEN = randomBytes(16).toString("hex");
  writeFileSync(TOKEN_FILE, TOKEN);
  try { chmodSync(TOKEN_FILE, 0o600); } catch {}
}

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = (process.env.ANTIGRAVITY_CLIENT_SECRET || "");
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const EP = {
  prod: "https://cloudcode-pa.googleapis.com",
  daily: "https://daily-cloudcode-pa.sandbox.googleapis.com",
  autopush: "https://autopush-cloudcode-pa.sandbox.googleapis.com",
};
const ACCOUNTS_PATH = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
const AUTH_PATH = "/root/.local/share/opencode/auth.json";
const GUARD_PATH = join(homedir(), ".config", "opencode", "antigravity.json");
const GUARD_DEFAULT = 70;
const OC_WEB_PASS_FILE = "/root/.local/share/opencode/opencode-web-pass";
let OPENCODE_WEB_PASS = "";
try { OPENCODE_WEB_PASS = readFileSync(OC_WEB_PASS_FILE, "utf8").trim(); } catch {}
const PKEYS_FILE = "/root/.local/share/opencode/pollinations_keys.json";
const AUTH_JSON = "/root/.local/share/opencode/auth.json";
function loadPKeys() {
  try {
    const j = JSON.parse(readFileSync(PKEYS_FILE, "utf8"));
    return Array.isArray(j.keys) ? j.keys : [];
  } catch { return []; }
}
function savePKeys(keys) {
  writeFileSync(PKEYS_FILE, JSON.stringify({ keys }, null, 2));
  try { chmodSync(PKEYS_FILE, 0o600); } catch {}
}
function activePKey() {
  try {
    const a = JSON.parse(readFileSync(AUTH_JSON, "utf8"));
    const e = a.pollinations;
    return (typeof e === "object" && e.key) ? e.key : (typeof e === "string" ? e : "");
  } catch { return ""; }
}
function setActivePKey(key) {
  const a = JSON.parse(readFileSync(AUTH_JSON, "utf8"));
  a.pollinations = { type: "api", key };
  writeFileSync(AUTH_JSON, JSON.stringify(a, null, 2));
}
const POL_TEMP_CODES = new Set([500, 502, 503, 504]);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function checkPKey(key, opts = {}) {
  const H = { Authorization: "Bearer " + key };
  const tries = Math.max(1, Number(opts.tries || 1));
  let last = { status: "error", balance: null, user: "", note: "تعذّر الاتصال" };
  for (let i = 0; i < tries; i++) {
    try {
      const p = await fetch("https://gen.pollinations.ai/account/profile", { headers: H, signal: AbortSignal.timeout(15000) });
      if (p.status === 401 || p.status === 403) return { status: "invalid", balance: null, user: "", note: "غير صالح" };
      if (p.status === 429) return { status: "limited", balance: null, user: "", note: "معدل الطلبات" };
      if (POL_TEMP_CODES.has(p.status)) {
        last = { status: "temp", balance: null, user: "", note: "خطأ خادم Pollinations (" + p.status + ")" };
        if (i < tries - 1) { await sleepMs(1200); continue; }
        return last;
      }
      if (!p.ok) return { status: "error", balance: null, user: "", note: "HTTP " + p.status };
      const pj = await p.json().catch(() => ({}));
      let balance = null, scoped = false;
      try {
        const b = await fetch("https://gen.pollinations.ai/account/balance", { headers: H, signal: AbortSignal.timeout(15000) });
        if (b.ok) { const bj = await b.json().catch(() => ({})); balance = bj.balance ?? bj.total ?? null; scoped = true; }
        else if (POL_TEMP_CODES.has(b.status)) return { status: "temp", balance: null, user: pj.githubUsername || "", note: "خطأ خادم Pollinations (" + b.status + ")" };
      } catch {}
      return { status: scoped ? "ok" : "limited", balance, user: pj.githubUsername || "", note: "" };
    } catch {
      last = { status: "error", balance: null, user: "", note: "تعذّر الاتصال" };
      if (i < tries - 1) await sleepMs(1200);
    }
  }
  return last;
}

// ---------- CodeCraft key pool + round-robin proxy ----------
// opencode points provider.codecraft at http://127.0.0.1:8899/codecraft/v1
// and this server fans requests out across the stored keys.
const CCKEYS_FILE = "/root/.local/share/opencode/codecraft_keys.json";
const CC_BASE = "https://codecraftapi.com/v1";
let ccNext = 0;
function loadCcKeys() {
  try {
    const j = JSON.parse(readFileSync(CCKEYS_FILE, "utf8"));
    const arr = Array.isArray(j.keys) ? j.keys : [];
    return arr.filter(k => k && typeof k.key === "string" && k.key.length > 8 && typeof k.name === "string");
  } catch { return []; }
}
function saveCcKeys(keys) {
  writeFileSync(CCKEYS_FILE, JSON.stringify({ keys }, null, 2));
  try { chmodSync(CCKEYS_FILE, 0o600); } catch {}
}
async function checkCcKey(key) {
  try {
    const r = await fetch(CC_BASE + "/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401 || r.status === 403) return { status: "invalid", models: 0 };
    if (!r.ok) return { status: "error", models: 0 };
    const j = await r.json().catch(() => ({}));
    return { status: "ok", models: Array.isArray(j.data) ? j.data.length : 0 };
  } catch { return { status: "error", models: 0 }; }
}
function ccReadBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 10e6) { resolve(null); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
async function ccProxy(req, res, u) {
  const keys = loadCcKeys();
  if (!keys.length) return send(res, 503, { error: "no codecraft keys configured – add one in the dashboard" });
  const rest = u.pathname.replace(/^\/codecraft\/v1\/?/, "");
  if (!/^[A-Za-z0-9_\-.\/]*$/.test(rest)) return send(res, 400, { error: "bad path" });
  const target = CC_BASE + "/" + rest + u.search;
  let body = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await ccReadBody(req);
    if (body === null) return send(res, 413, { error: "payload too large" });
  }
  const n = keys.length;
  let status = 502, detail = "all codecraft keys failed";
  for (let i = 0; i < n; i++) {
    const idx = (ccNext + i) % n;
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: { "Content-Type": req.headers["content-type"] || "application/json", Accept: req.headers.accept || "*/*", Authorization: "Bearer " + keys[idx].key },
        body, signal: AbortSignal.timeout(120000),
      });
      if (r.status === 400) {
        const t = await r.text().catch(() => "");
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(t);
        return;
      }
      if (r.ok) {
        ccNext = (idx + 1) % n;
        res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
        if (r.body) for await (const chunk of r.body) { if (!res.write(chunk)) await new Promise(x => res.once("drain", x)); }
        res.end();
        return;
      }
      status = r.status;
      try { detail = (await r.text()).slice(0, 200); } catch { detail = "key failed with " + r.status; }
    } catch { status = 502; detail = "upstream unreachable"; }
  }
  return send(res, status, { error: "all codecraft keys failed", detail });
}

const OC_INFERENCE_BASE = process.env.AG_OC_INFERENCE_BASE || "https://opencode.ai/inference/openai/v1";
const OC_PROXIES_FILE = process.env.AG_PROXY_POOL_FILE || "/root/.config/opencode/opencode_proxies.json";
// Quarantined proxies live next to the pool so the state survives a restart.
const OC_QUARANTINE_FILE = process.env.AG_PROXY_QUARANTINE_FILE
  || OC_PROXIES_FILE.replace(/\.json$/, "") + ".quarantine.json";
// How many proxies one request may try before the error is handed to the client.
const OC_MAX_TRIES = Math.max(1, Number(process.env.AG_OC_MAX_TRIES || 5));
// How long a proxy stays out of rotation after a poisoning upstream error.
const OC_QUARANTINE_TTL = Number(process.env.AG_OC_QUARANTINE_TTL_MS || DEFAULT_QUARANTINE_TTL_MS);
// Only for tests against a self-signed local upstream.
const OC_TARGET_INSECURE = process.env.AG_OC_TARGET_INSECURE === "1";
// Hosts whose proxies may carry a personal API key. Everything else is an
// anonymous public proxy and must never see the key.
const OC_TRUSTED_PROXY_HOSTS = (process.env.AG_OC_TRUSTED_PROXY_HOSTS || "dc.decodo.com")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
// Optional narrowing: a comma separated list of exact "host:port" entries.
// When it is set, ONLY those entries are trusted.
const OC_TRUSTED_PROXY_ENTRIES = (process.env.AG_OC_TRUSTED_PROXY_ENTRIES || "")
  .split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
// A response larger than this is not buffered (protects the dashboard memory).
const OC_MAX_BUFFER = 32 * 1024 * 1024;
const quarantine = createQuarantineStore(OC_QUARANTINE_FILE);
let ocNext = 0;
// The last upstream error we saw. When every proxy is quarantined we hand
// this back to the client so it keeps the real reason (429 + retryAfterMs)
// instead of a bare 503.
let lastOcPoison = null;

function normalizeProxy(p) {
  p = String(p || "").trim();
  if (!p || p.startsWith("#")) return null;
  if (p.startsWith("http://") || p.startsWith("https://") || p.startsWith("socks5://")) return p;
  const parts = p.split(":");
  if (parts.length === 4) {
    return `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 2) {
    return `http://${parts[0]}:${parts[1]}`;
  }
  return null;
}

// Hides the password of a proxy url for display.
function maskProxyUrl(u) {
  try {
    const p = new URL(u);
    const user = decodeURIComponent(p.username || "");
    return p.protocol + "//" + (user ? user + ":***@" : "") + p.hostname + (p.port ? ":" + p.port : "");
  } catch { return u; }
}

function loadOcProxies() {
  try {
    const raw = readFileSync(OC_PROXIES_FILE, "utf8").trim();
    if (!raw) return [];
    if (raw.startsWith("{") || raw.startsWith("[")) {
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : (Array.isArray(j.proxies) ? j.proxies : []);
      return list.map(normalizeProxy).filter(Boolean);
    }
    return raw.split("\n").map(normalizeProxy).filter(Boolean);
  } catch {
    return [];
  }
}

const CONFIG_JSONC = process.env.AG_OPENCODE_CONFIG || "/root/.config/opencode/opencode.jsonc";

// The proxy that works with the opencode provider is a CONNECT tunnel in the
// target container's environment (HTTPS_PROXY), not an HTTP proxy served by
// this dashboard: opencode.ai tells the transports apart and answers 429 to
// the Node-terminated one (measured 2026-11-08).
// The state is therefore read from the container — the old string grep of the
// config file reported a false "enabled" while the traffic went out directly.
async function isOcProxyEnabled() {
  const state = await readOcContainerProxy();
  return !!(state && state.enabled);
}

function saveOcProxies(list) {
  writeFileSync(OC_PROXIES_FILE, JSON.stringify({ proxies: list }, null, 2), "utf8");
}

// --- full-pool health check job -------------------------------------------

const PROXY_CHECK = {
  host: process.env.AG_PROXY_CHECK_HOST || "api.ipify.org",
  port: Number(process.env.AG_PROXY_CHECK_PORT || 443),
  path: process.env.AG_PROXY_CHECK_PATH || "/?format=json",
  timeout: Number(process.env.AG_PROXY_CHECK_TIMEOUT || 8000),
  insecure: process.env.AG_PROXY_CHECK_INSECURE === "1",
  concurrency: Number(process.env.AG_PROXY_CHECK_CONCURRENCY || 20),
};

let proxyCheckJob = null; // { running, total, tested, ok:[], failed:[], startedAt, finishedAt }

function startProxyCheck() {
  if (proxyCheckJob && proxyCheckJob.running) return { started: false, reason: "already running", ...proxyCheckJob };
  const list = loadOcProxies();
  proxyCheckJob = {
    running: true, total: list.length, tested: 0,
    ok: [], failed: [], startedAt: Date.now(), finishedAt: null,
  };
  const job = proxyCheckJob;
  checkPool(list, {
    concurrency: PROXY_CHECK.concurrency,
    timeout: PROXY_CHECK.timeout,
    host: PROXY_CHECK.host,
    port: PROXY_CHECK.port,
    path: PROXY_CHECK.path,
    insecure: PROXY_CHECK.insecure,
    onProgress: (p) => {
      job.tested = p.done;
      job.total = p.total;
      job.ok = p.okList || job.ok;
      job.failed = p.failedList || job.failed;
    },
  }).then((out) => {
    job.ok = out.ok;
    job.failed = out.failed;
    job.results = out.results;
  }).catch((e) => {
    job.failed = [{ url: "", error: String(e && e.message ? e.message : e) }];
  }).finally(() => {
    job.running = false;
    job.tested = job.total;
    job.finishedAt = Date.now();
  });
  return { started: true, total: list.length };
}

function proxyCheckStatus() {
  if (!proxyCheckJob) return { running: false, total: 0, tested: 0, ok: [], failed: [], results: [], pruned: false };
  const { running, total, tested, ok, failed, results, startedAt, finishedAt, pruned, prunedAt } = proxyCheckJob;
  // Only report failures that are still in the pool — anything already
  // removed must not be offered for deletion again.
  let liveFailed = failed || [];
  if (!running && liveFailed.length) {
    const inPool = new Set(loadOcProxies());
    liveFailed = liveFailed.filter((f) => inPool.has(f.url));
  }
  return {
    running, total, tested, ok,
    failed: liveFailed,
    results: results || [],
    startedAt, finishedAt,
    pruned: !!pruned || (!!failed && failed.length > 0 && liveFailed.length === 0),
    prunedAt: prunedAt || null,
  };
}

// Removes the failed proxies from the pool, keeping a timestamped backup.
// Idempotent: pruning an already-clean pool is a no-op, not an error.
function pruneOcProxies() {
  if (!proxyCheckJob || proxyCheckJob.running) return { ok: false, error: "no completed check" };
  const failed = proxyCheckJob.failed || [];
  const current = loadOcProxies();
  if (!failed.length) {
    return { ok: true, removed: 0, count: current.length, backup: null, alreadyClean: true, message: "لا يوجد فاشل لحذفه — المسبح نظيف" };
  }
  const out = pruneFailed(current, failed.map((f) => f.url).filter(Boolean), { allowEmpty: true });
  if (out.removed === 0) {
    // Already pruned (or the pool changed underneath) — not an error.
    proxyCheckJob.failed = [];
    proxyCheckJob.pruned = true;
    proxyCheckJob.prunedAt = Date.now();
    return { ok: true, removed: 0, count: current.length, backup: null, alreadyClean: true, message: "الفاشل محذوف مسبقاً" };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = OC_PROXIES_FILE + ".bak-" + stamp;
  try { copyFileSync(OC_PROXIES_FILE, backup); } catch {}
  saveOcProxies(out.list);
  // Clear the failure list so a reload does not offer to delete them again.
  proxyCheckJob.failed = [];
  proxyCheckJob.pruned = true;
  proxyCheckJob.prunedAt = Date.now();
  return { ok: true, removed: out.removed, count: out.list.length, backup, alreadyClean: false };
}

// The upstream may compress its answer; we only need the plain text to look
// for a poisoning error, the bytes we forward stay untouched.
function ocBodyText(headers, buf) {
  const enc = String((headers && headers["content-encoding"]) || "").toLowerCase();
  try {
    if (enc === "gzip") return zlib.gunzipSync(buf).toString("utf8");
    if (enc === "deflate") return zlib.inflateSync(buf).toString("utf8");
    if (enc === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
    if (enc === "zstd") return zlib.zstdDecompressSync(buf).toString("utf8");
  } catch {}
  return buf.toString("utf8");
}

// Node already de-chunked the body, so the framing headers must not be
// forwarded as they are.
function ocResponseHeaders(headers, bodyLength) {
  const h = { ...(headers || {}) };
  delete h["transfer-encoding"];
  if (bodyLength === null || bodyLength === undefined) delete h["content-length"];
  else h["content-length"] = String(bodyLength);
  return h;
}

/**
 * Forward one request through one proxy and report what happened instead of
 * writing to the client. The caller decides what to do with the outcome:
 *   { kind: "response", status, headers, body }  -> hand it to the client
 *   { kind: "stream", status, headers, stream }   -> pipe it to the client
 *   { kind: "poisoned", reason, ... }             -> the exit IP is unusable
 *   { kind: "network-error", error }              -> the proxy itself failed
 */
async function forwardViaProxy(proxyUrl, targetUrl, req, body) {
  const t = new URL(targetUrl);
  let tunnel = null;
  let agent = null;
  const cleanup = () => {
    try { agent && agent.destroy(); } catch {}
    try { tunnel && tunnel.destroy(); } catch {}
    agent = null;
    tunnel = null;
  };
  try {
    // Supports http://, https:// and socks5:// proxies through one tunnel API.
    tunnel = await openProxyTunnel(proxyUrl, t.hostname, Number(t.port || 443), { timeout: 15000 });
    const agentOptions = { socket: tunnel };
    if (OC_TARGET_INSECURE) agentOptions.rejectUnauthorized = false;
    agent = new https.Agent(agentOptions);
    const h = { ...req.headers };
    delete h.host;
    delete h.connection;
    h.host = t.hostname;
    if (!h.authorization) h.authorization = "Bearer public";
    if (process.env.AG_OC_DEBUG_HEADERS === "1") {
      try {
        const safe = {};
        for (const [k, v] of Object.entries(h)) {
          safe[k] = /authorization|api-key|cookie/i.test(k) ? String(v).slice(0, 24) + "…" : v;
        }
        appendFileSync("/tmp/opencode/oc-headers.log", JSON.stringify(safe) + "\n");
      } catch {}
    }

    const result = await new Promise((resolve) => {
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; resolve(val); } };
      const forwardReq = https.request({
        host: t.hostname,
        port: Number(t.port || 443),
        path: t.pathname + t.search,
        method: req.method,
        headers: h,
        agent,
        timeout: 120000,
      }, (targetRes) => {
        const headers = targetRes.headers || {};
        const ctype = String(headers["content-type"] || "");
        const isEventStream = /text\/event-stream/i.test(ctype);
        // A 429/403 is worth inspecting even when it arrives as a stream.
        const mustInspect = !isEventStream || targetRes.statusCode === 429 || targetRes.statusCode === 403;

        if (!mustInspect) {
          // Real stream: hand it over untouched so tokens keep flowing.
          targetRes.on("error", () => {});
          targetRes.on("end", cleanup);
          targetRes.on("close", cleanup);
          done({ kind: "stream", status: targetRes.statusCode, headers: ocResponseHeaders(headers, null), stream: targetRes });
          return;
        }

        const chunks = [];
        let total = 0;
        targetRes.on("data", (c) => {
          chunks.push(c);
          total += c.length;
          if (total > OC_MAX_BUFFER) {
            try { targetRes.destroy(); } catch {}
            done({ kind: "network-error", error: "response too large" });
          }
        });
        targetRes.on("end", () => {
          const buf = Buffer.concat(chunks);
          const verdict = classifyUpstream(targetRes.statusCode, ocBodyText(headers, buf));
          const outHeaders = ocResponseHeaders(headers, buf.length);
          if (verdict.kind === "poison") {
            done({ kind: "poisoned", reason: verdict.reason, status: targetRes.statusCode, headers: outHeaders, body: buf });
            return;
          }
          if (verdict.kind === "fail-fast") {
            // The shared pool is spent: answer the client now, keep the
            // retry-after, and do not park the exit IP.
            done({ kind: "fail-fast", reason: verdict.reason, status: targetRes.statusCode, headers: outHeaders, body: buf });
            return;
          }
          done({ kind: "response", status: targetRes.statusCode, headers: outHeaders, body: buf });
        });
        targetRes.on("error", () => done({ kind: "network-error", error: "target stream error" }));
      });
      forwardReq.on("error", (e) => done({ kind: "network-error", error: String(e && e.message ? e.message : e).slice(0, 160) }));
      forwardReq.on("timeout", () => { forwardReq.destroy(); done({ kind: "network-error", error: "timeout" }); });
      if (body) forwardReq.write(body);
      forwardReq.end();
    });
    if (result.kind === "stream") return result;
    cleanup();
    return result;
  } catch (e) {
    cleanup();
    return { kind: "network-error", error: String(e && e.message ? e.message : e).slice(0, 160) };
  }
}

async function ocProxy(req, res, u) {
  const rest = u.pathname.replace(/^\/opencode-proxy\/v1\/?/, "");
  if (!/^[A-Za-z0-9_\-.\/]*$/.test(rest)) return send(res, 400, { error: "bad path" });
  const targetUrl = OC_INFERENCE_BASE + "/" + rest + u.search;

  let body = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await ccReadBody(req);
    if (body === null) return send(res, 413, { error: "payload too large" });
  }

  const proxies = loadOcProxies();
  // A request with a personal API key may only travel through the trusted
  // (residential) proxies; an anonymous "Bearer public" request may use all.
  const personal = isPersonalKeyRequest(req.headers);
  const trustedHosts = OC_TRUSTED_PROXY_ENTRIES.length
    ? [...OC_TRUSTED_PROXY_HOSTS, ...OC_TRUSTED_PROXY_ENTRIES]
    : OC_TRUSTED_PROXY_HOSTS;
  const usable = selectProxiesForRequest(proxies, { personal, trustedHosts });
  if (!usable.length) {
    return send(res, personal ? 503 : 503, personal
      ? { error: "no trusted proxy available for an authenticated request", personal: true }
      : { error: "no proxies available in opencode_proxies.json" });
  }

  const n = usable.length;
  const start = ocNext % n;
  let tried = 0;
  let lastPoison = null;
  let lastError = null;
  for (let i = 0; i < n && tried < OC_MAX_TRIES; i++) {
    const idx = (start + i) % n;
    const proxyUrl = usable[idx];
    // A quarantined proxy is skipped without spending a try.
    if (quarantine.has(proxyUrl)) continue;
    tried++;
    const result = await forwardViaProxy(proxyUrl, targetUrl, req, body);
    if (result.kind === "fail-fast") {
      // The shared anonymous pool is spent: every exit IP answers the same
      // way, so switching cannot help. The client gets the real error (and
      // the retry-after) right away.
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      ocNext = (idx + 1) % n;
      return;
    }
    if (result.kind === "poisoned") {
      // The exit IP is not usable: park the proxy for a while and try another.
      quarantine.add(proxyUrl, result.reason, { ttlMs: OC_QUARANTINE_TTL });
      lastPoison = result;
      lastOcPoison = result;
      continue;
    }
    if (result.kind === "network-error") { lastError = result; continue; }
    if (result.kind === "stream") {
      res.writeHead(result.status, result.headers);
      result.stream.pipe(res);
      ocNext = (idx + 1) % n;
      return;
    }
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    ocNext = (idx + 1) % n;
    return;
  }

  if (tried === 0) {
    // Every proxy is parked right now: answer with the last real upstream
    // error so the client still knows what is going on.
    if (lastOcPoison) {
      res.writeHead(lastOcPoison.status, lastOcPoison.headers);
      res.end(lastOcPoison.body);
      return;
    }
    return send(res, 503, { error: "every proxy in the pool is quarantined", quarantine: quarantine.list().length });
  }
  if (lastPoison) {
    // Nothing better is available: the client gets the real upstream error.
    res.writeHead(lastPoison.status, lastPoison.headers);
    res.end(lastPoison.body);
    return;
  }
  if (!res.headersSent) send(res, 502, { error: "all proxies in the pool failed", detail: lastError ? lastError.error : "" });
}

function getGuard() {
  try {
    const v = JSON.parse(readFileSync(GUARD_PATH, "utf8")).soft_quota_threshold_percent;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  } catch {}
  return GUARD_DEFAULT;
}
function setGuard(n) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(GUARD_PATH, "utf8")); } catch {}
  cfg.soft_quota_threshold_percent = n;
  writeFileSync(GUARD_PATH, JSON.stringify(cfg, null, 2));
  return n;
}

// Antigravity client identity — loaded from antigravity-identity.json so a new
// client version can be rolled out without editing code. Google gates the
// Antigravity tier on the version in the User-Agent: 1.x gets HTTP 200 whose
// body is the "no longer supported" notice instead of a model answer.
const watchIdentityWarnings = createIdentityWatcher();
function agIdentity() {
  const identity = loadIdentity();
  for (const warning of watchIdentityWarnings(identity)) {
    console.warn("[antigravity-identity]", warning);
  }
  return identity;
}
function AG_HEADERS() {
  return identityHeaders(agIdentity());
}

// ---------- helpers ----------
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const clamp01 = (v) => (typeof v !== "number" || Number.isNaN(v) ? undefined : Math.min(1, Math.max(0, v)));

function loadAccounts() {
  try {
    return JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8"));
  } catch {
    return { version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: { claude: 0, gemini: 0 } };
  }
}
function saveAccounts(store) {
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(store, null, 2));
  try { chmodSync(ACCOUNTS_PATH, 0o600); } catch {}
}

// ---------- account write helpers (backup before every mutation) ----------
const ACCOUNTS_BACKUP_DIR = join(homedir(), ".local", "share", "opencode", "config-backup");
function backupAccounts(reason) {
  try {
    mkdirSync(ACCOUNTS_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dst = join(ACCOUNTS_BACKUP_DIR, `antigravity-accounts.${stamp}.${reason}.json`);
    copyFileSync(ACCOUNTS_PATH, dst);
    try { chmodSync(dst, 0o600); } catch {}
    const keep = readdirSync(ACCOUNTS_BACKUP_DIR)
      .filter((f) => f.startsWith("antigravity-accounts."))
      .sort()
      .slice(0, -30);
    for (const f of keep) { try { unlinkSync(join(ACCOUNTS_BACKUP_DIR, f)); } catch {} }
    return dst;
  } catch {
    return null;
  }
}
function loadAuth() {
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf8")); } catch { return {}; }
}
function saveAuth(store) {
  writeFileSync(AUTH_PATH, JSON.stringify(store, null, 2));
  try { chmodSync(AUTH_PATH, 0o600); } catch {}
}

async function refreshAccessToken(rawRefresh) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: rawRefresh, grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("token refresh failed: " + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error("no access_token in refresh response");
  return j;
}

async function discoverProject(accessToken) {
  // Full Antigravity headers are required: without them Google returns
  // tiers instead of the managed cloudaicompanionProject.
  const h = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...AG_HEADERS() };
  for (const base of [EP.prod, EP.daily, EP.autopush]) {
    try {
      const r = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const p = d.cloudaicompanionProject?.id || d.cloudaicompanionProject || "";
      if (p) return p;
    } catch {}
  }
  return "";
}

function familyOf(modelName) {
  const l = (modelName || "").toLowerCase();
  if (l.includes("claude")) return "claude";
  if (l.includes("flash")) return "gemini-flash";
  return "gemini-pro";
}
function classifyGroup(modelName, displayName) {
  const c = `${modelName} ${displayName || ""}`.toLowerCase();
  if (c.includes("claude")) return "claude";
  if (!c.includes("gemini")) return null;
  return c.includes("flash") ? "gemini-flash" : "gemini-pro";
}
// Live per-account status from plugin-maintained signals (lastUsed,
// rateLimitResetTimes, activeIndexByFamily) — the only truthful signals,
// since fetchAvailableModels always reports 100%.
function liveStatus(a, idx, fam) {
  const now = Date.now();
  let until = 0;
  const scope = new Set();
  for (const [k, v] of Object.entries(a.rateLimitResetTimes || {})) {
    const t = Number(v);
    if (Number.isFinite(t) && t > now) {
      if (t > until) until = t;
      scope.add(/^claude/i.test(k) ? "claude" : "gemini");
    }
  }
  const active = [];
  for (const [f, i] of Object.entries(fam || {})) if (i === idx) active.push(f);
  return { idx, lastUsed: a.lastUsed || null, limitedUntil: until || null, limitedScope: [...scope], active };
}
// Merge fresh fetch groups over plugin-written exhaustion records instead of
// wiping them; expired records (reset passed) are dropped. Per-model lists
// and counts always come from the freshest available source.
function mergeQuotaGroups(oldG, freshG) {
  const out = { ...(freshG || {}) };
  const now = Date.now();
  const live = (g) => {
    if (!g || typeof g.remainingFraction !== "number") return null;
    const rt = g.resetTime ? Date.parse(g.resetTime) : NaN;
    if (Number.isFinite(rt) && rt < now) return null;
    return g;
  };
  for (const k of ["gemini-flash", "gemini-pro", "claude"]) {
    const o = live((oldG || {})[k]);
    const f = out[k] || null;
    const fRem = f && typeof f.remainingFraction === "number" ? f.remainingFraction : null;
    const oRem = o ? o.remainingFraction : null;
    let rem = null;
    if (fRem !== null && oRem !== null) rem = Math.min(fRem, oRem);
    else rem = fRem !== null ? fRem : oRem;
    if (rem === null) { if (!f) delete out[k]; continue; }
    const src = oRem !== null && oRem <= (fRem === null ? Infinity : fRem) ? o : f;
    out[k] = { ...(f || {}), remainingFraction: rem };
    if (f && f.models) out[k].models = f.models;
    else if (o && o.models) out[k].models = o.models;
    if (o && o.modelCount && !(f && f.modelCount)) out[k].modelCount = o.modelCount;
    if (src && src.resetTime) out[k].resetTime = src.resetTime;
    else if (f && f.resetTime) out[k].resetTime = f.resetTime;
  }
  return out;
}
// Overlay LIVE exhaustion onto the displayed bar: a family with a
// future-dated rate limit is really at 0% until then, no matter what the
// weekly fetchAvailableModels figure claims. Display-only (never persisted).
function applyLiveLimits(quota, rateLimitResetTimes) {
  if (!quota) return quota;
  const now = Date.now();
  const famReset = {};
  for (const [k, v] of Object.entries(rateLimitResetTimes || {})) {
    const t = Number(v);
    if (!Number.isFinite(t) || t <= now) continue;
    const fams = /^claude/i.test(k) ? ["claude"] : ["gemini-flash", "gemini-pro"];
    for (const f of fams) if (!famReset[f] || t > famReset[f]) famReset[f] = t;
  }
  for (const [f, t] of Object.entries(famReset)) {
    if (!quota[f]) quota[f] = { modelCount: 0 };
    quota[f] = { ...quota[f], remainingFraction: 0, resetTime: new Date(t).toISOString() };
  }
  return quota;
}

async function fetchQuotaFor(accessToken, projectId) {
  const body = projectId ? { project: projectId } : {};
  const r = await fetch(`${EP.prod}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": AG_HEADERS()["User-Agent"],
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("quota fetch failed: " + r.status);
  const data = await r.json();
  const models = data.models || data || {};
  const groups = {};
  let total = 0;
  for (const [name, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") continue;
    const g = classifyGroup(name, entry.displayName || entry.modelName);
    if (!g) continue;
    total++;
    const rem = clamp01(entry.quotaInfo?.remainingFraction);
    const reset = entry.quotaInfo?.resetTime;
    const ex = groups[g] || {};
    const exModels = ex.models || [];
    if (rem !== undefined || reset) exModels.push({ n: name, rem: rem ?? null, rst: reset || null });
    groups[g] = {
      remainingFraction: rem === undefined ? ex.remainingFraction : (ex.remainingFraction === undefined ? rem : Math.min(ex.remainingFraction, rem)),
      resetTime: reset && (!ex.resetTime || Date.parse(reset) < Date.parse(ex.resetTime)) ? reset : ex.resetTime,
      modelCount: (ex.modelCount || 0) + 1,
      models: exModels,
    };
  }
  return { groups, modelCount: total };
}

const TEST_MODELS = ["gemini-2.5-flash", "gemini-3-flash", "gemini-3.8-flash", "gemini-3.8-flash-tiered", "gemini-2.5-pro", "gemini-3.1-pro"];

async function testAccountModel(email, model) {
  if (!TEST_MODELS.includes(model)) return { ok: false, error: "unknown model" };
  const store = loadAccounts();
  const a = store.accounts.find((x) => x.email === email);
  if (!a) return { ok: false, error: "account not found" };
  let access;
  try {
    const t = await refreshAccessToken((a.refreshToken || "").split("|")[0]);
    access = t.access_token;
  } catch (e) { return { ok: true, email, model, results: [], verdict: "❌ التوكن مرفوض — أعد تسجيل الحساب" }; }
  const project = a.projectId || "aicode-consumers";
  const payload = JSON.stringify({
    project, model,
    request: {
      model,
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: TST" }] }],
      generationConfig: { maxOutputTokens: 16, temperature: 0 },
    },
    requestType: "agent", userAgent: "antigravity", requestId: "test-" + Date.now(),
  });
  const eps = [["daily", EP.daily], ["autopush", EP.autopush], ["prod", EP.prod]];
  const results = [];
  for (const [name, base] of eps) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", ...AG_HEADERS() },
        body: payload, signal: AbortSignal.timeout(25000),
      });
      const text = await r.text();
      const ok = r.ok && /TST/i.test(text);
      results.push({ endpoint: name, status: r.status, ms: Date.now() - t0, ok,
        detail: ok ? text.match(/"text"\s*:\s*"([^"]{1,80})/)?.[1] || "رد سليم" : text.slice(0, 140).replace(/\s+/g, " ") });
    } catch (e) { results.push({ endpoint: name, status: 0, ms: Date.now() - t0, ok: false, detail: "تعذر الوصول: " + String(e.message || e).slice(0, 80) }); }
  }
  const good = results.find((r) => r.ok);
  const st = Object.fromEntries(results.map((r) => [r.endpoint, r.status]));
  let verdict;
  if (good) verdict = `✅ يعمل على ${good.endpoint} (${good.ms}ms)`;
  else if (st.daily === 404 && st.autopush === 404 && st.prod === 429) verdict = "⏳ النموذج موجود على prod فقط وكوتته مستنفدة — أعد الاختبار بعد التصفير";
  else if (results.every((r) => r.status === 404)) verdict = "❌ النموذج غير موجود على هذه المسارات";
  else if (results.every((r) => r.status === 429)) verdict = "⏳ الكوتة مستنفدة على كل المسارات — انتظر التصفير";
  else if (results.some((r) => r.status === 403)) verdict = "⛔ رفض ترخيص — تحقق من مشروع الحساب";
  else if (results.some((r) => r.status === 503)) verdict = "🔄 لا سعة حاليًا لدى Google — أعد المحاولة لاحقًا";
  else verdict = "⚠ نتائج مختلطة — راجع التفاصيل";
  return { ok: true, email, model, results, verdict };
}

// pending PKCE logins: state -> { verifier, createdAt }
const pending = new Map();
function newAuthorization() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(Buffer.from(JSON.stringify({ verifier, projectId: "" }), "utf8"));
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  pending.set(state, { verifier, createdAt: Date.now() });
  return { url: u.toString(), state };
}

function parseCallback(input, fallbackState) {
  const t = (input || "").trim();
  if (!t) return { error: "empty input" };
  try {
    const u = new URL(t);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state") || fallbackState;
    if (!code) return { error: "no code in URL" };
    if (!state) return { error: "no state — paste the full URL, not just the code" };
    return { code, state };
  } catch {
    if (!fallbackState) return { error: "paste the full redirect URL (code alone needs a pending login)" };
    return { code: t.split("&")[0].split("=")[0].replace(/^code=/, ""), state: fallbackState };
  }
}

async function finishLogin(input) {
  for (const [s, p] of pending) if (Date.now() - p.createdAt > 15 * 60 * 1000) pending.delete(s);
  const latest = [...pending.keys()].pop() || "";
  const parsed = parseCallback(input, latest);
  if (parsed.error) return { ok: false, error: parsed.error };
  const pend = pending.get(parsed.state);
  const verifier = pend ? pend.verifier : JSON.parse(Buffer.from(parsed.state, "base64url").toString("utf8")).verifier;

  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      code: parsed.code, grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!tr.ok) return { ok: false, error: "token exchange failed: " + (await tr.text()).slice(0, 200) };
  const tok = await tr.json();
  if (!tok.refresh_token) return { ok: false, error: "Google did not return a refresh token" };

  let email = "";
  try {
    const ur = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (ur.ok) email = (await ur.json()).email || "";
  } catch {}

  const project = await discoverProject(tok.access_token);
  const now = Date.now();
  const store = loadAccounts();
  const idx = store.accounts.findIndex((a) => email && a.email === email);
  const entry = {
    email: email || undefined,
    refreshToken: tok.refresh_token,
    projectId: project || "",
    addedAt: idx >= 0 ? store.accounts[idx].addedAt : now,
    lastUsed: now,
    enabled: true,
  };
  if (idx >= 0) store.accounts[idx] = { ...store.accounts[idx], ...entry };
  else store.accounts.push(entry);
  saveAccounts(store);

  const auth = loadAuth();
  auth.google = {
    type: "oauth",
    refresh: `${tok.refresh_token}|${project || ""}`,
    access: tok.access_token,
    expires: now + (tok.expires_in || 3600) * 1000,
    email: email || undefined,
    projectId: project || "",
  };
  saveAuth(auth);
  pending.delete(parsed.state);
  return { ok: true, email, project };
}

// ---------- HTTP ----------
function send(res, code, obj, type = "application/json") {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(s));
  });
}

const GUEST_TTL = 24 * 3600; // guest cookie lifetime (seconds)
const GUEST_SECRET_FILE = "/root/.local/share/opencode/ag-guest-secret";
let GUEST_SECRET = "";
try { GUEST_SECRET = readFileSync(GUEST_SECRET_FILE, "utf8").trim(); } catch {}
if (!/^[0-9a-f]{32}$/.test(GUEST_SECRET)) {
  GUEST_SECRET = randomBytes(16).toString("hex");
  writeFileSync(GUEST_SECRET_FILE, GUEST_SECRET);
  try { chmodSync(GUEST_SECRET_FILE, 0o600); } catch {}
}
const signGuest = (email) => createHash("sha256").update(GUEST_SECRET + "\n" + email).digest("hex").slice(0, 32);
const makeGuestCookie = (email) => `ag_guest=${encodeURIComponent(email)}.${signGuest(email)}; Max-Age=${GUEST_TTL}; Path=/; SameSite=Lax; HttpOnly`;
function guestEmailFrom(req) {
  try {
    const m = (req.headers.cookie || "").match(/(?:^|;\s*)ag_guest=([^;]+)/);
    if (!m) return null;
    const raw = m[1];
    const dot = raw.lastIndexOf(".");
    if (dot < 0) return null;
    const enc = raw.slice(0, dot), sig = raw.slice(dot + 1);
    const email = decodeURIComponent(enc);
    if (!email || signGuest(email) !== sig) return null;
    return email;
  } catch { return null; }
}

function checkBasic(req) {
  try {
    const creds = JSON.parse(readFileSync("/root/.local/share/opencode/ag-dashboard-auth", "utf8"));
    const h = req.headers.authorization || "";
    if (!h.startsWith("Basic ")) return null;
    const [u, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    const p = rest.join(":");
    if (creds.admin && u === creds.admin.user && p === creds.admin.pass) return "admin";
    if (creds.guest && u === creds.guest.user && p === creds.guest.pass) return "guest";
    return null;
  } catch { return null; }
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  // CodeCraft rotation proxy: loopback only (opencode inside this container).
  // External traffic arrives from the docker gateway IP, never loopback.
  if (u.pathname === "/codecraft/v1" || u.pathname.startsWith("/codecraft/v1/")) {
    const ip = req.socket.remoteAddress || "";
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return send(res, 403, { error: "loopback only" });
    try { return await ccProxy(req, res, u); }
    catch { if (!res.headersSent) return send(res, 502, { error: "proxy failed" }); return; }
  }
  // OpenCode residential proxy: loopback only
  if (u.pathname === "/opencode-proxy/v1" || u.pathname.startsWith("/opencode-proxy/v1/")) {
    const ip = req.socket.remoteAddress || "";
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return send(res, 403, { error: "loopback only" });
    try { return await ocProxy(req, res, u); }
    catch (e) { if (!res.headersSent) return send(res, 502, { error: "proxy failed", detail: e.message }); return; }
  }
  const path = u.pathname;
  let role = checkBasic(req);
  const isGuestRoute = path === "/guest" || path === "/guest/";
  const isGuestApi = path === "/api/login/start" || path === "/api/login/finish" || path === "/api/mine";

  if (!role) {
    if (isGuestRoute || isGuestApi) {
      role = "guest";
    } else {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ag-dashboard"', "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "login required" }));
      return;
    }
  }
  const tok = u.searchParams.get("token");
  if (tok && tok !== TOKEN) return send(res, 403, { error: "bad token" });

  try {
    if (req.method === "GET" && (path === "/" || isGuestRoute)) {
      return send(res, 200, (role === "guest" || isGuestRoute) ? GUEST_PAGE : PAGE, "text/html");
    }

    if (path === "/api/state" || path === "/api/guard" || path === "/api/test" || path === "/api/mkdir" || path === "/api/dirs" || path === "/api/open" || path === "/api/close" || path === "/api/sessions" || path === "/api/newproject" || path === "/api/rmdir" || path === "/api/pkeys" || path === "/api/pkeys/activate" || path === "/api/cckeys" || path === "/api/accounts/toggle" || path === "/api/accounts/remove" || path.startsWith("/api/proxies")) {
      if (role !== "admin") return send(res, 403, { error: "admin only" });
    }

    if (req.method === "GET" && path === "/api/pkeys") {
      let keys = loadPKeys();
      let act = activePKey();
      if (!keys.length && act) {
        keys = [{ name: "الأساسي", key: act, addedAt: Date.now() }];
        savePKeys(keys);
      }
      if (!act && keys.length) { act = keys[0].key; setActivePKey(act); }
      const checks = await Promise.all(keys.map((k) => checkPKey(k.key, { tries: 2 })));
      const out = [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], c = checks[i];
        let usage = null;
        if (c.status === "ok") {
          try {
            const u = await fetch("https://gen.pollinations.ai/account/usage?limit=200", { headers: { Authorization: "Bearer " + k.key }, signal: AbortSignal.timeout(20000) });
            if (u.ok) {
              const uj = await u.json().catch(() => ({}));
              const byModel = {};
              let reqs = 0, cost = 0;
              for (const e of (uj.usage || [])) {
                reqs++;
                const cu = Number(e.cost_usd || 0);
                cost += cu;
                const m = e.model || "?";
                byModel[m] = byModel[m] || { model: m, reqs: 0, tokens: 0, cost: 0 };
                byModel[m].reqs++;
                byModel[m].tokens += (Number(e.input_text_tokens || 0) + Number(e.output_text_tokens || 0));
                byModel[m].cost += cu;
              }
              const top = Object.values(byModel).sort((a, b) => b.cost - a.cost).slice(0, 5);
              usage = { reqs, cost: Math.round(cost * 10000) / 10000, top };
            }
          } catch {}
        }
        out.push({ name: k.name, masked: "…" + String(k.key).slice(-4), user: c.user, balance: c.balance, status: c.status, note: c.note || "", active: k.key === act, usage });
      }
      return send(res, 200, { keys: out, count: out.length, serviceDown: out.some((k) => k.status === "temp") });
    }

    if (req.method === "POST" && path === "/api/pkeys") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim().slice(0, 30);
      const key = String(body.key || "").trim();
      if (!name || !/^sk_[A-Za-z0-9_-]{16,}$/.test(key)) return send(res, 400, { error: "bad key" });
      const keys = loadPKeys();
      if (keys.some((k) => k.name === name)) return send(res, 400, { error: "name exists" });
      if (keys.some((k) => k.key === key)) return send(res, 400, { error: "key exists" });
      const c = await checkPKey(key, { tries: 2 });
      if (c.status === "invalid") return send(res, 400, { error: "key rejected" });
      keys.push({ name, key, addedAt: Date.now() });
      savePKeys(keys);
      if (!activePKey()) setActivePKey(key);
      return send(res, 200, { ok: true, name, status: c.status, note: c.note || "" });
    }

    if (req.method === "DELETE" && path === "/api/pkeys") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      let keys = loadPKeys();
      const gone = keys.find((k) => k.name === name);
      if (!gone) return send(res, 400, { error: "not found" });
      const wasActive = gone.key === activePKey();
      keys = keys.filter((k) => k.name !== name);
      savePKeys(keys);
      if (wasActive) {
        if (keys.length) setActivePKey(keys[0].key);
        else {
          try {
            const a = JSON.parse(readFileSync(AUTH_JSON, "utf8"));
            delete a.pollinations;
            writeFileSync(AUTH_JSON, JSON.stringify(a, null, 2));
          } catch {}
        }
      }
      return send(res, 200, { ok: true, name });
    }

    if (req.method === "POST" && path === "/api/pkeys/activate") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      const k = loadPKeys().find((x) => x.name === name);
      if (!k) return send(res, 400, { error: "not found" });
      setActivePKey(k.key);
      return send(res, 200, { ok: true, name });
    }

    if (req.method === "GET" && path === "/api/cckeys") {
      const keys = loadCcKeys();
      const out = [];
      for (const k of keys) {
        const c = await checkCcKey(k.key);
        out.push({ name: k.name, masked: "…" + String(k.key).slice(-4), status: c.status, models: c.models });
      }
      return send(res, 200, { keys: out, count: out.length });
    }

    if (req.method === "POST" && path === "/api/cckeys") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim().slice(0, 30);
      const key = String(body.key || "").trim();
      if (!name || !/^cc_[A-Za-z0-9]{8,}$/.test(key)) return send(res, 400, { error: "bad key" });
      const keys = loadCcKeys();
      if (keys.some((k) => k.name === name)) return send(res, 400, { error: "name exists" });
      if (keys.some((k) => k.key === key)) return send(res, 400, { error: "key exists" });
      const c = await checkCcKey(key);
      if (c.status !== "ok") return send(res, 400, { error: "key rejected" });
      keys.push({ name, key, addedAt: Date.now() });
      saveCcKeys(keys);
      return send(res, 200, { ok: true, name, models: c.models });
    }

    if (req.method === "DELETE" && path === "/api/cckeys") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      const keys = loadCcKeys();
      if (!keys.some((k) => k.name === name)) return send(res, 400, { error: "not found" });
      saveCcKeys(keys.filter((k) => k.name !== name));
      return send(res, 200, { ok: true, name });
    }

    if (req.method === "GET" && path === "/api/proxies") {
      const list = loadOcProxies();
      const state = await readOcContainerProxy();
      const enabled = !!(state && state.enabled);
      const proxies = list.map((p, idx) => {
        try {
          const u = new URL(p);
          return {
            id: idx,
            host: u.hostname,
            port: u.port,
            user: decodeURIComponent(u.username || ""),
            masked: `${u.protocol}//${decodeURIComponent(u.username || "")}:***@${u.hostname}:${u.port}`
          };
        } catch {
          return { id: idx, host: p, port: "", user: "", masked: p };
        }
      });
      return send(res, 200, {
        enabled,
        count: proxies.length,
        proxies,
        tunnel: {
          enabled,
          proxy: state?.proxy || "",
          container: state?.container || "",
          status: state?.status || "",
          startedAt: state?.startedAt || "",
          error: state?.error || "",
        },
      });
    }

    // The real state of the CONNECT tunnel (HTTPS_PROXY in the container).
    if (req.method === "GET" && path === "/api/proxies/oc-proxy") {
      const state = await readOcContainerProxy();
      return send(res, state.ok ? 200 : 503, state);
    }

    // Switching the tunnel on/off recreates the target container (Docker's
    // update API ignores Env), so this request ends with the dashboard: the
    // helper writes its log to recreate-proxy.log and the panel reloads.
    if (req.method === "POST" && path === "/api/proxies/toggle") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const want = !!body.enabled;
      const state = await readOcContainerProxy();
      if (want === !!(state && state.enabled)) {
        return send(res, 200, { ok: true, unchanged: true, enabled: !!(state && state.enabled) });
      }
      try {
        const r = want
          ? await enableOcContainerProxy({ smoke: String(body.smoke || "opencode/crouton-alpha-free") })
          : await disableOcContainerProxy();
        if (!r.ok) return send(res, 400, { ok: false, error: r.error || "failed to start the helper" });
        return send(res, 200, {
          ok: true,
          started: true,
          enabled: want,
          proxy: r.proxy || "",
          note: "The container is being recreated — the server restarts in ~30 seconds. Reload this page.",
        });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    }

    if (req.method === "POST" && path === "/api/proxies/oc-proxy/rollback") {
      try {
        const r = await rollbackOcContainerProxy();
        if (!r.ok) return send(res, 400, { ok: false, error: r.error || "failed to start the helper" });
        return send(res, 200, { ok: true, started: true, note: "Rolling back — the server restarts in ~30 seconds." });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    }

    if (req.method === "GET" && path === "/api/proxies/quarantine") {
      const quarantined = quarantine.list().map(e => ({
        url: e.url,
        masked: maskProxyUrl(e.url),
        reason: e.reason,
        until: e.until,
        at: e.at,
        hits: e.hits,
      }));
      return send(res, 200, { count: quarantined.length, quarantined });
    }

    if (req.method === "POST" && path === "/api/proxies/quarantine/clear") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const url = String(body.url || "").trim();
      const cleared = quarantine.clear(url || null);
      return send(res, 200, { ok: true, cleared, count: quarantine.size() });
    }

    if (req.method === "POST" && path === "/api/proxies") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const input = String(body.input || "").trim();
      if (!input) return send(res, 400, { error: "input required" });
      const current = loadOcProxies();
      const lines = input.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
      let added = 0;
      for (const line of lines) {
        const norm = normalizeProxy(line);
        if (norm && !current.includes(norm)) {
          current.push(norm);
          added++;
        }
      }
      saveOcProxies(current);
      return send(res, 200, { ok: true, added, count: current.length });
    }

    if (req.method === "DELETE" && path === "/api/proxies") {
      const body = JSON.parse((await readBody(req)) || "{}");
      let current = loadOcProxies();
      const before = current.length;
      const url = String(body.url || "").trim();
      if (url) current = current.filter(p => p !== url);
      else if (Number.isInteger(body.id) && body.id >= 0 && body.id < current.length) current.splice(body.id, 1);
      if (current.length === before) return send(res, 404, { error: "proxy not found" });
      saveOcProxies(current);
      return send(res, 200, { ok: true, count: current.length });
    }

    if (req.method === "POST" && path === "/api/proxies/test") {
      const body = JSON.parse((await readBody(req)) || "{}");
      let url = String(body.url || "").trim();
      if (!url && Number.isInteger(body.id)) url = loadOcProxies()[body.id] || "";
      if (!url) return send(res, 400, { error: "url required" });
      // Uses the very same tunnel as live traffic, so a pass means it really works.
      const out = await testProxy(url, {
        host: PROXY_CHECK.host,
        port: PROXY_CHECK.port,
        path: PROXY_CHECK.path,
        timeout: PROXY_CHECK.timeout,
        insecure: PROXY_CHECK.insecure,
      });
      return send(res, 200, out);
    }

    if (req.method === "POST" && path === "/api/proxies/test-all") {
      const out = startProxyCheck();
      return send(res, 200, out);
    }

    if (req.method === "GET" && path === "/api/proxies/test-all/status") {
      return send(res, 200, proxyCheckStatus());
    }

    if (req.method === "POST" && path === "/api/proxies/prune") {
      const out = pruneOcProxies();
      return send(res, out.ok ? 200 : 400, out);
    }

    if (!OPENCODE_WEB_PASS) OPENCODE_WEB_PASS = process.env.OPENCODE_SERVER_PASSWORD || "";

    const ocFetch = (p, opts = {}) => fetch("http://127.0.0.1:4096" + p, {
      ...opts,
      headers: { Authorization: "Basic " + Buffer.from("opencode:" + OPENCODE_WEB_PASS).toString("base64"), "Content-Type": "application/json", ...(opts.headers || {}) },
    });

    if (req.method === "POST" && path === "/api/close") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = String(body.id || "").trim();
      if (!/^ses_[A-Za-z0-9]+$/.test(id)) return send(res, 400, { error: "bad id" });
      if (!OPENCODE_WEB_PASS) return send(res, 500, { error: "no web password" });
      try {
        let r = await ocFetch("/api/session/" + id, { method: "DELETE" });
        if (!r.ok) r = await ocFetch("/session/" + id, { method: "DELETE" });
        if (!r.ok) return send(res, 400, { error: "delete failed" });
        return send(res, 200, { ok: true, id });
      } catch (e) { return send(res, 500, { error: "delete failed" }); }
    }

    if (req.method === "POST" && path === "/api/rmdir") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      if (!name || name.length > 80 || name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith(".") || !/^[\p{L}\p{N} _\-.]+$/u.test(name)) {
        return send(res, 400, { error: "bad name" });
      }
      try {
        rmdirSync(join("/workspace", name));
      } catch (e) {
        if (e.code === "ENOENT") return send(res, 400, { error: "not found" });
        return send(res, 400, { error: "not empty" });
      }
      return send(res, 200, { ok: true, name });
    }

    if (req.method === "POST" && path === "/api/newproject") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      if (!name || name.length > 80 || name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith(".") || !/^[\p{L}\p{N} _\-.]+$/u.test(name)) {
        return send(res, 400, { error: "bad name" });
      }
      if (!OPENCODE_WEB_PASS) return send(res, 500, { error: "no web password" });
      const dir = "/workspace/" + name;
      try { mkdirSync(dir, { recursive: false }); }
      catch (e) { if (e.code !== "EEXIST") return send(res, 400, { error: "mkdir failed" }); }
      try {
        let r = await ocFetch("/api/session", {
          method: "POST",
          body: JSON.stringify({
            title: "📁 " + name,
            agent: "build",
            model: { id: "gemini-3.8-flash", providerID: "antigravity" },
            location: { directory: dir }
          }),
        });
        if (!r.ok) {
          r = await ocFetch("/session?directory=" + encodeURIComponent(dir), {
            method: "POST",
            body: JSON.stringify({ title: "📁 " + name, agent: "build", model: { id: "gemini-3.8-flash-tiered", providerID: "google" } }),
          });
        }
        const j = await r.json();
        const sessionID = j.id || j.data?.id;
        if (!r.ok || !sessionID) return send(res, 400, { error: "open failed" });
        return send(res, 200, { ok: true, sessionID, name });
      } catch (e) { return send(res, 500, { error: "open failed" }); }
    }

    if (req.method === "POST" && path === "/api/open") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      if (!name || name.length > 80 || name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith(".") || !/^[\p{L}\p{N} _\-.]+$/u.test(name)) {
        return send(res, 400, { error: "bad name" });
      }
      if (!OPENCODE_WEB_PASS) return send(res, 500, { error: "no web password" });
      const dir = "/workspace/" + name;
      try {
        let r = await ocFetch("/api/session", {
          method: "POST",
          body: JSON.stringify({
            title: "📁 " + name,
            agent: "build",
            model: { id: "gemini-3.8-flash", providerID: "antigravity" },
            location: { directory: dir }
          }),
        });
        if (!r.ok) {
          r = await ocFetch("/session?directory=" + encodeURIComponent(dir), {
            method: "POST",
            body: JSON.stringify({ title: "📁 " + name, agent: "build", model: { id: "gemini-3.8-flash-tiered", providerID: "google" } }),
          });
        }
        const j = await r.json();
        const sessionID = j.id || j.data?.id;
        if (!r.ok || !sessionID) return send(res, 400, { error: "open failed" });
        return send(res, 200, { ok: true, sessionID, name });
      } catch (e) { return send(res, 500, { error: "open failed" }); }
    }

    if (req.method === "GET" && path === "/api/sessions") {
      if (!OPENCODE_WEB_PASS) return send(res, 200, { sessions: [] });
      try {
        let r = await ocFetch("/api/session");
        if (!r.ok) r = await ocFetch("/session");
        if (!r.ok) return send(res, 500, { error: "fetch failed" });
        const j = await r.json();
        const rawList = Array.isArray(j) ? j : (j.data || []);
        let parents = {};
        rawList.forEach((s) => { if (s.parentID) parents[s.id] = true; });
        const sessions = rawList.map((s) => ({
          id: s.id,
          title: s.title || "",
          directory: s.location?.directory || s.directory || "",
          agent: s.agent || "",
          model: (s.model && s.model.id) || "",
          tokens: ((s.tokens && s.tokens.input) || 0) + ((s.tokens && s.tokens.output) || 0),
          cost: s.cost || 0,
          created: (s.time && s.time.created) || 0,
          updated: (s.time && s.time.updated) || 0,
          child: !!parents[s.id],
        })).sort((a, b) => b.updated - a.updated);
        return send(res, 200, { sessions, count: sessions.length });
      } catch (e) { return send(res, 500, { error: "fetch failed" }); }
    }

    if (req.method === "GET" && path === "/api/dirs") {
      let dirs = [];
      try {
        dirs = readdirSync("/workspace", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      } catch {}
      const out = [];
      let allSessions = [];
      if (OPENCODE_WEB_PASS) {
        try {
          const r = await ocFetch("/api/session");
          if (r.ok) {
            const j = await r.json();
            allSessions = Array.isArray(j) ? j : (j.data || []);
          }
        } catch {}
      }
      for (const name of dirs) {
        const dirPath = "/workspace/" + name;
        const sessions = allSessions
          .filter((s) => (s.location?.directory === dirPath || s.directory === dirPath))
          .map((s) => ({ id: s.id, title: s.title || "", time: (s.time && s.time.created) || 0 }));
        out.push({ name, sessions });
      }
      return send(res, 200, { dirs: out });
    }

    if (req.method === "POST" && path === "/api/mkdir") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = String(body.name || "").trim();
      if (!name || name.length > 80 || name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith(".") || !/^[\p{L}\p{N} _\-.]+$/u.test(name)) {
        return send(res, 400, { error: "bad name" });
      }
      try {
        mkdirSync(join("/workspace", name), { recursive: false });
      } catch (e) {
        return send(res, 400, { error: e.code === "EEXIST" ? "exists" : "failed" });
      }
      return send(res, 200, { ok: true, name });
    }

    if (req.method === "POST" && path === "/api/test") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await testAccountModel(body.email || "", body.model || "");
      return send(res, out.ok ? 200 : 400, out);
    }

    if (req.method === "GET" && path === "/api/mine") {
      const email = guestEmailFrom(req);
      if (!email) return send(res, 200, { account: null });
      const store = loadAccounts();
      const idx = store.accounts.findIndex((x) => x.email === email);
      const a = store.accounts[idx];
      if (!a) return send(res, 200, { account: null });
      const item = { email: a.email, projectId: a.projectId || "", quota: a.cachedQuota || null, quotaUpdatedAt: a.cachedQuotaUpdatedAt || null, quotaError: null, ...liveStatus(a, idx, store.activeIndexByFamily) };
      if (u.searchParams.get("refresh") === "1") {
        try {
          const t = await refreshAccessToken((a.refreshToken || "").split("|")[0]);
          const q = await fetchQuotaFor(t.access_token, a.projectId || "");
          item.quota = mergeQuotaGroups(a.cachedQuota, q.groups);
          a.cachedQuota = item.quota;
          a.cachedQuotaUpdatedAt = Date.now();
          saveAccounts(store);
        } catch (e) { item.quotaError = String(e.message || e).slice(0, 160); }
      }
      if (item.quota) item.quota = applyLiveLimits({ ...item.quota }, a.rateLimitResetTimes);
      return send(res, 200, { account: item });
    }

    if (req.method === "GET" && path === "/api/state") {
      const store = loadAccounts();
      const live = u.searchParams.get("refresh") === "1";
      const accounts = [];
      for (let idx = 0; idx < store.accounts.length; idx++) {
        const a = store.accounts[idx];
        const item = { email: a.email || "(unknown)", projectId: a.projectId || "", enabled: a.enabled !== false, quota: a.cachedQuota || null, quotaUpdatedAt: a.cachedQuotaUpdatedAt || null, quotaError: null, ...liveStatus(a, idx, store.activeIndexByFamily) };
        if (live) {
          try {
            const raw = (a.refreshToken || "").split("|")[0];
            const t = await refreshAccessToken(raw);
            const q = await fetchQuotaFor(t.access_token, a.projectId || "");
            item.quota = mergeQuotaGroups(a.cachedQuota, q.groups);
            a.cachedQuota = item.quota;
            a.cachedQuotaUpdatedAt = Date.now();
          } catch (e) {
            item.quotaError = String(e.message || e).slice(0, 160);
          }
        }
        accounts.push({ ...item, quota: item.quota ? applyLiveLimits({ ...item.quota }, a.rateLimitResetTimes) : item.quota });
      }
      if (live) saveAccounts(store);
      return send(res, 200, { accounts, count: accounts.length });
    }

    if (req.method === "POST" && path === "/api/accounts/toggle") {
      if (role === "guest") return send(res, 403, { error: "forbidden" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const email = String(body.email || "").trim();
      if (!email) return send(res, 400, { error: "email required" });
      const store = loadAccounts();
      const idx = store.accounts.findIndex((a) => (a.email || "") === email);
      if (idx < 0) return send(res, 404, { error: "account not found" });
      const backup = backupAccounts("pre-toggle");
      const acc = store.accounts[idx];
      const nextEnabled = acc.enabled === false;
      acc.enabled = nextEnabled;
      if (nextEnabled) {
        delete acc.verificationRequired;
        delete acc.verificationRequiredAt;
        delete acc.verificationRequiredReason;
        delete acc.verificationUrl;
      }
      saveAccounts(store);
      return send(res, 200, { ok: true, email, enabled: nextEnabled, backup, note: "أعد تشغيل الحاوية لتطبيق التغيير على البرنامج المساعد" });
    }

    if (req.method === "POST" && path === "/api/accounts/remove") {
      if (role === "guest") return send(res, 403, { error: "forbidden" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const email = String(body.email || "").trim();
      if (!email) return send(res, 400, { error: "email required" });
      const store = loadAccounts();
      const idx = store.accounts.findIndex((a) => (a.email || "") === email);
      if (idx < 0) return send(res, 404, { error: "account not found" });
      if (store.accounts.length <= 1) return send(res, 400, { error: "cannot remove the last account" });
      const backup = backupAccounts("pre-remove");
      store.accounts.splice(idx, 1);
      const maxIdx = store.accounts.length - 1;
      const clamp = (v) => Math.max(0, Math.min(Number.isInteger(v) ? v : 0, maxIdx));
      store.activeIndex = clamp(store.activeIndex);
      if (store.activeIndexByFamily) {
        store.activeIndexByFamily.claude = clamp(store.activeIndexByFamily.claude);
        store.activeIndexByFamily.gemini = clamp(store.activeIndexByFamily.gemini);
      }
      saveAccounts(store);
      try {
        const auth = loadAuth();
        if (auth.google && auth.google.email === email) {
          const nextAcc = store.accounts.find((a) => a.enabled !== false) || store.accounts[0];
          if (nextAcc) {
            auth.google.email = nextAcc.email;
            auth.google.refresh = `${nextAcc.refreshToken}|${nextAcc.projectId || ""}`;
            delete auth.google.access;
            delete auth.google.expires;
          } else {
            delete auth.google;
          }
          saveAuth(auth);
        }
      } catch {}
      return send(res, 200, { ok: true, removed: email, count: store.accounts.length, backup, note: "تم حذف الحساب بنجاح وتحديث كافة الاعتماديات" });
    }

    if (req.method === "POST" && path === "/api/login/start") {
      const { url } = newAuthorization();
      return send(res, 200, { url });
    }

    if (req.method === "POST" && path === "/api/login/finish") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await finishLogin(body.input || "");
      if (out.ok && role === "guest" && out.email) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": makeGuestCookie(out.email),
        });
        res.end(JSON.stringify(out));
        return;
      }
      return send(res, out.ok ? 200 : 400, out);
    }

    if (req.method === "GET" && path === "/api/guard") {
      const v = getGuard();
      return send(res, 200, { value: v, disabled: v === 100 });
    }

    if (req.method === "POST" && path === "/api/guard") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const n = Number(body.value);
      if (!Number.isInteger(n) || n < 1 || n > 100) return send(res, 400, { error: "value must be 1-100" });
      return send(res, 200, { value: setGuard(n), disabled: n === 100 });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e).slice(0, 300) });
  }
});

setInterval(async () => {
  try {
    const keys = loadPKeys();
    if (!keys.length) return;
    let act = activePKey();
    if (!act) { act = keys[0].key; setActivePKey(act); }
    const c = await checkPKey(act, { tries: 2 });
    if (c.status === "temp") return;
    if (c.status === "invalid" || c.status === "error") {
      for (const k of keys) {
        if (k.key === act) continue;
        const c2 = await checkPKey(k.key, { tries: 1 });
        if (c2.status === "temp") return;
        if (c2.status === "ok" || c2.status === "limited") { setActivePKey(k.key); return; }
      }
      return;
    }
    if ((c.balance ?? 0) <= 0) {
      let best = null, bestBal = 0;
      for (const k of keys) {
        if (k.key === act) continue;
        const c2 = await checkPKey(k.key, { tries: 1 });
        const b = Number(c2.balance ?? -1);
        if ((c2.status === "ok" || c2.status === "limited") && b > bestBal) { best = k; bestBal = b; }
      }
      if (best) setActivePKey(best.key);
    }
  } catch {}
}, 5 * 60 * 1000);

// A single stray socket error must never take the whole dashboard down.
process.on("uncaughtException", (err) => {
  console.error("[ag-dashboard] uncaught (ignored):", err && err.message ? err.message : err);
});
process.on("unhandledRejection", (err) => {
  console.error("[ag-dashboard] unhandled rejection (ignored):", err && err.message ? err.message : err);
});

server.listen(PORT, "0.0.0.0", () => {
  const actual = server.address() && server.address().port ? server.address().port : PORT;
  console.log(`ag-dashboard on http://0.0.0.0:${actual}/?token=${TOKEN}`);
});

const PAGE = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة حسابات Antigravity</title>
<style>
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}
body{font-family:system-ui,sans-serif;background:#0f1420;color:#e8ecf4;margin:0;padding:14px;max-width:640px;margin-inline:auto;width:100%}
h1{font-size:20px;margin:8px 0 2px}h2{font-size:16px;margin:18px 0 8px;color:#9fb4d8}
.sub{color:#8b93a7;font-size:13px;margin-bottom:12px}
.card{background:#1a2233;border:1px solid #2a3550;border-radius:12px;padding:12px;margin:10px 0;min-width:0}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;flex-wrap:wrap;min-width:0}
.email{font-weight:700;min-width:0;overflow-wrap:anywhere;word-break:break-word}.proj{color:#8b93a7;font-size:12px;direction:ltr;overflow-wrap:anywhere;word-break:break-word}
.bar{height:10px;background:#2a3550;border-radius:6px;overflow:hidden;margin:4px 0 2px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#34d399,#10b981);border-radius:6px}
.bar.low>i{background:linear-gradient(90deg,#fbbf24,#f59e0b)}.bar.zero>i{background:#ef4444}
.qlab{font-size:12px;color:#9fb4d8;display:flex;justify-content:space-between}
button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 16px;font-size:15px;width:100%;margin-top:8px;cursor:pointer}
button.sec{background:#2a3550}button:disabled{opacity:.5}
a.btn{display:block;text-align:center;background:#059669;color:#fff;border-radius:10px;padding:12px;font-size:15px;text-decoration:none;margin-top:8px}
textarea{width:100%;max-width:100%;min-height:90px;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:13px;direction:ltr}
ol{font-size:13px;color:#c6cfdf;line-height:1.9;padding-inline-start:20px}
.msg{border-radius:10px;padding:10px;margin-top:8px;font-size:14px;display:none}
.msg.ok{display:block;background:#064e3b}.msg.err{display:block;background:#7f1d1d}
.gbtns{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px}
.gbtns button{margin-top:0;padding:10px 4px;font-size:14px}
.gbtn.on{outline:2px solid #34d399}
.trow{display:flex;gap:8px;margin-top:8px;min-width:0}
.trow select{flex:1;min-width:0;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:13px;direction:ltr}
.trow button{width:auto;margin-top:0;padding:10px 14px;white-space:nowrap}
.arow{align-items:center;margin-top:6px}
.arow .abtn-x{background:#4a2230;color:#ffb3c1}
.arow .ares{font-size:12px}
.pcol{flex-direction:column;align-items:stretch}
.pcol button{width:100%;margin-top:8px}
.orow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #2a3550;flex-wrap:wrap;min-width:0}
.orow button{width:auto;margin-top:0;padding:8px 12px;font-size:13px;white-space:nowrap}
.orow .dbtn{background:#7f1d1d}
.srow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0 4px 14px;font-size:13px;color:#9fb4d8;flex-wrap:wrap;min-width:0}
.srow button{width:auto;margin-top:0;padding:6px 10px;font-size:12px;white-space:nowrap;background:#7f1d1d}
.tabs{position:sticky;top:0;background:#0f1420;padding:8px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;z-index:10}
@media(min-width:550px){.tabs{grid-template-columns:repeat(6,1fr)}}
.tabbtn{margin-top:0;background:#2a3550;padding:10px 2px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tabbtn.on{background:#2563eb}
.tabsec{display:none;min-width:0}
.tabsec.on{display:block}
.cbtn2{width:auto;margin-top:0;padding:6px 12px;font-size:13px;background:#7f1d1d;white-space:nowrap}
.pact,.pdel{width:auto;margin-top:0;padding:8px 12px;font-size:13px;white-space:nowrap}
.pdel{background:#7f1d1d}
.tres{margin-top:6px;font-size:12px;line-height:1.9}
.tok{color:#34d399}.tbad{color:#f87171}.tmid{color:#fbbf24}
.mut{font-size:12px;color:#8b93a7}
.stline{font-size:11px;color:#8b93a7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xfam{cursor:pointer}
.xlist{column-count:1;margin-top:2px}
.xlist .mut{margin:0;font-size:11px;line-height:1.7;break-inside:avoid}
@media(min-width:700px){.xlist{column-count:2;column-gap:14px}}
/* ---- بروكسيات: منع التجاوز الأفقي على الهاتف ---- */
.pxcard{min-width:0;overflow:hidden}
.pxurl{direction:ltr;text-align:left;display:block;font-size:13px;font-weight:600;word-break:break-all;overflow-wrap:anywhere;white-space:normal;max-width:100%;min-width:0}
.pxacts{display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0}
.pxacts button{width:auto;margin-top:0;padding:8px 12px;font-size:13px;white-space:nowrap}
.pxres{font-size:12px;word-break:break-word;overflow-wrap:anywhere}
.pxbar{height:10px;background:#2a3550;border-radius:6px;overflow:hidden;margin:6px 0}
.pxbar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#34d399,#10b981);transition:width .2s}
.pxstat{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#9fb4d8;flex-wrap:wrap}
.pxgrid{display:flex;flex-direction:column;gap:6px}
.pxline{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;padding:6px 8px;background:#111827;border-radius:8px;min-width:0;flex-wrap:wrap}
.pxline>span:first-child{direction:ltr;text-align:left;word-break:break-all;overflow-wrap:anywhere;min-width:0;flex:1 1 160px}
.pxtog{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pxtog button{width:auto;margin-top:0;padding:8px 14px;font-size:14px;white-space:nowrap}
@media(max-width:520px){
  .pxline>span:first-child{flex:1 1 100%}
  .pxline>span:last-child{flex:1 1 100%;text-align:right}
}
</style></head><body>
<h1>🔑 حسابات Antigravity</h1>
<div class="sub">طبقة مساعدة لـ opencode — تسجيل الدخول وعرض الكوتة من المتصفح</div>
<div class="tabs">
<button class="tabbtn on" data-t="acc">🔑 حسابات</button>
<button class="tabbtn" data-t="proj">📁 مشاريع</button>
<button class="tabbtn" data-t="sess">💬 جلسات</button>
<button class="tabbtn" data-t="pol">🌸 Polli</button>
<button class="tabbtn" data-t="cc">🌀 CodeCraft</button>
<button class="tabbtn" data-t="proxy">🌐 البروكسيات</button>
</div>
<div class="tabsec on" id="tab-acc">

<h2>الحسابات (<span id="count">…</span>)</h2>
<div id="list"><div class="mut">جارٍ التحميل…</div></div>
<button class="sec" id="refresh">↻ تحديث الكوتة الآن</button>

<h2>🛡 الحارس الناعم (<span id="guardVal">…</span>)</h2>
<div class="card">
<div class="mut">عند بلوغ استهلاك الحساب هذه النسبة يُتخطى تلقائيًا للحساب التالي. 100٪ = معطّل.</div>
<div class="gbtns">
<button class="sec gbtn" data-v="70">70٪</button>
<button class="sec gbtn" data-v="80">80٪</button>
<button class="sec gbtn" data-v="90">90٪</button>
<button class="sec gbtn" data-v="100">إيقاف ⛔</button>
</div>
<div class="msg" id="guardMsg"></div>
<div class="mut">يسري على عمليات opencode الجديدة فورًا.</div>
</div>

<h2>➕ إضافة حساب جديد</h2>
<div class="card">
<button id="start">١) توليد رابط الدخول</button>
<div id="loginArea" style="display:none">
<ol>
<li>افتح الرابط التالي في نفس المتصفح وسجّل بحساب Google ووافق:</li>
</ol>
<a class="btn" id="oauthLink" href="#" target="_blank" rel="noopener">فتح صفحة الدخول ←</a>
<ol start="2">
<li>بعد الموافقة ستظهر صفحة خطأ (<span dir="ltr">localhost:51121</span>) — طبيعي تمامًا. انسخ الرابط كاملًا من شريط العنوان.</li>
<li>ارجع هنا واضغط الزر المباشر أدناه (سيقرأ الحافظة وينهي الربط فورًا):</li>
</ol>
<button id="pasteFinish" class="btn" style="background:#059669;margin-top:4px">📋 لصق الرابط من الحافظة وإتمام فورًا</button>
<details style="margin-top:12px">
<summary class="mut" style="cursor:pointer">أو الصق يدويًا هنا إذا تعذر الوصول للحافظة ▼</summary>
<textarea id="cb" style="margin-top:6px" placeholder="http://localhost:51121/oauth-callback?code=…"></textarea>
<button id="finish" class="sec">إتمام تسجيل الدخول يدويًا</button>
</details>
<div class="msg" id="loginMsg"></div>
</div></div>
</div>
<div class="tabsec" id="tab-proj">
<h2>📁 المشاريع</h2>
<div class="card">
<div class="trow pcol"><input id="pjname" placeholder="اسم المشروع الجديد" style="flex:1;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:14px"><button id="pjBtn">➕ مشروع جديد</button></div>
<div class="mut">ينشئ المجلد + جلسة مرتبطة به (بالوكيل والنموذج الافتراضيين) — دون المرور بالنموذج اللغوي.</div>
<div class="trow pcol"><input id="mdir" placeholder="اسم المجلد" style="flex:1;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:14px"><button class="sec" id="mkdirBtn">إنشاء 📁</button></div>
<div class="msg" id="mkdirMsg"></div>
<div class="mut">يُنشأ داخل <span dir="ltr">/workspace</span> مباشرة — بلا نموذج.</div>
<div class="mut" id="dirList" style="margin-top:6px"></div>
</div>
</div>
<div class="tabsec" id="tab-sess">
<h2>💬 الجلسات (<span id="scount">…</span>)</h2>
<div class="mut"><label><input type="checkbox" id="showChild" checked> إظهار الفروع 🌿</label></div>
<div id="slist"><div class="mut">جارٍ التحميل…</div></div>
<button class="sec" id="srefresh">↻ تحديث الجلسات</button>
</div>
<div class="tabsec" id="tab-pol">
<h2>🌸 مفاتيح Pollinations (<span id="pcount">…</span>)</h2>
<div class="card">
<div class="trow pcol"><input id="pname" placeholder="اسم المفتاح (مثال: احتياطي)" style="flex:1;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:14px"><input id="pkey" placeholder="sk_..." dir="ltr" style="flex:1;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:13px"><button id="paddBtn">➕ إضافة مفتاح</button></div>
<div class="msg" id="pmsg"></div>
<div class="mut">التدوير تلقائي كل 5 دقائق عند فشل النشط. حدود الاستخدام تتجدد كل ساعة.</div>
</div>
<div id="plist"><div class="mut">جارٍ التحميل…</div></div>
<button class="sec" id="prefresh">↻ تحديث المفاتيح</button>
</div>
<div class="tabsec" id="tab-cc">
<h2>🌀 مفاتيح CodeCraft (<span id="cccount">…</span>)</h2>
<div class="card">
<div class="trow pcol"><input id="ccname" placeholder="اسم المفتاح (مثال: احتياطي)" style="flex:1;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:14px"><input id="cckey" placeholder="cc_..." dir="ltr" style="flex:1;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:13px"><button id="ccaddBtn">➕ إضافة مفتاح</button></div>
<div class="msg" id="ccmsg"></div>
<div class="mut">تدوير تلقائي بالتناوب على المفاتيح مع تجاوز الفاشل (401/429/5xx). يُتحقق من كل مفتاح قبل حفظه.</div>
</div>
<div id="cclist"><div class="mut">جارٍ التحميل…</div></div>
<button class="sec" id="ccrefresh">↻ تحديث المفاتيح</button>
</div>
<div class="tabsec" id="tab-proxy">
<h2>🌐 بروكسيات نماذج OpenCode (<span id="proxyCount">…</span>)</h2>
<div class="card pxcard">
<div class="pxtog">
  <span style="font-weight:600;min-width:0">توجيه نماذج OpenCode عبر البروكسي:</span>
  <button id="proxyToggleBtn" class="sec">…</button>
  <button id="proxyRollbackBtn" class="sec" style="background:#7f1d1d">↩︎ تراجع</button>
</div>
<div class="mut">الزر يبدّل <b>نفق CONNECT</b> داخل حاوية opencode-server (<span dir="ltr">HTTPS_PROXY</span>) — وهو المسار الوحيد الذي ينجح مع نماذج OpenCode: المسار عبر هذه اللوحة ينهي TLS في Node فيرد opencode.ai بـ<code>429</code>، بينما نفق CONNECT يُبقي TLS للعميل نفسه. التبديل يُعيد إنشاء الحاوية (انقطاع ~30 ثانية) مع نسخة احتياطية.</div>
</div>
<div class="card pxcard">
<div style="font-weight:600;margin-bottom:6px">🧪 اختبار شامل + تنظيف المسبح</div>
<button id="proxyTestAllBtn">🧪 اختبار كل البروكسيات</button>
<div class="pxbar" id="proxyBar" style="display:none"><i id="proxyBarFill"></i></div>
<div class="pxstat" id="proxyStat" style="display:none">
  <span id="proxyStatProg">…</span><span id="proxyStatCount">…</span>
</div>
<div id="proxyResultBox" style="display:none;margin-top:8px">
  <div class="pxgrid" id="proxyFailList"></div>
  <button id="proxyPruneBtn" class="sec" style="background:#7f1d1d;margin-top:8px">🗑 حذف الفاشل</button>
</div>
<div class="msg" id="proxyTestMsg"></div>
<div class="mut" style="margin-top:6px">الاختبار يمرّ عبر كل بروكسي فعلياً (نفس مسار المرور الحقيقي) ويتحقق من IP الخروج. الفشل يعني أن البروكسي لا يحمل طلبات فعلاً.</div>
</div>
<div class="card pxcard">
<div style="font-weight:600;margin-bottom:6px">➕ إضافة بروكسي (فردي أو لصق قائمة كاملة):</div>
<textarea id="proxyInput" placeholder="أدخل بروكسي أو الصق قائمة كاملة (سطر لكل بروكسي)&#10;الصيغة: host:port:user:pass أو http://user:pass@host:port" style="width:100%;max-width:100%;height:85px;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:13px;font-family:monospace" dir="ltr"></textarea>
<div style="display:flex;gap:10px;margin-top:8px">
  <button id="proxyAddBtn" style="flex:1;min-width:0">➕ إضافة البروكسيات إلى المسبح</button>
</div>
<div class="msg" id="proxyMsg"></div>
<div class="mut" style="margin-top:6px">التدوير يتم تلقائياً بالتتابع (Round-Robin) مع تجاوز أي بروكسي يتعثر تلقائياً. الأنواع المدعومة: http و https و socks5.</div>
</div>
<div id="proxyList"><div class="mut">جارٍ التحميل…</div></div>
<div class="card pxcard" id="proxyQuarantineCard" style="display:none">
  <div style="font-weight:600;margin-bottom:6px">🔒 بروكسيات محجورة (<span id="proxyQuarantineCount">0</span>)</div>
  <div class="mut" style="margin-bottom:8px">حُجرت لأن opencode.ai رجّع «غير متاح في بلدك» أو «تجاوزت الحصة المجانية» عبر عنوانها. تُتخطّى تلقائياً لمدة ساعة ثم تعود للمسبح.</div>
  <div class="pxgrid" id="proxyQuarantineList"></div>
  <button id="proxyQuarantineClearBtn" class="sec" style="margin-top:8px">↩ إرجاعهم للمسبح</button>
</div>
<button class="sec" id="proxyRefresh">↻ تحديث القائمة</button>
</div>

<script>
const T = new URLSearchParams(location.search).get("token") || "";
const api = (p, o) => fetch(p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(T), o).then(r => r.json());
const pct = f => (f === undefined || f === null) ? "؟" : Math.round(f * 100) + "٪";
const bar = f => f === undefined ? "" : (f <= 0 ? "zero" : (f < 0.3 ? "low" : ""));
const rst = t => { if (!t) return ""; try { const d = new Date(t); return "تصفير: " + d.toLocaleString("ar") } catch { return t } };
const NAMES = { "gemini-flash": "⚡ Gemini Flash", "gemini-pro": "🧠 Gemini Pro", "claude": "🟠 Claude" };
const famName = f => f === "claude" ? "Claude" : "Gemini";
const dt = t => { try { return new Date(t).toLocaleString("ar", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) } catch { return "" } };
function statusLine(a) {
  const parts = [];
  if (a.enabled === false) parts.push("⏸ معطّل");
  if (a.active && a.active.length) parts.push("🟢 " + a.active.map(famName).join("+"));
  if (a.limitedUntil) parts.push("⏳ " + (a.limitedScope || []).map(famName).join("+") + " حتى " + dt(a.limitedUntil));
  parts.push(a.lastUsed ? "· " + dt(a.lastUsed) : "جديد");
  return '<div class="stline">' + parts.join(" · ") + "</div>";
}

async function load(live) {
  document.getElementById("list").innerHTML = '<div class="mut">جارٍ التحميل…</div>';
  const d = await api("/api/state" + (live ? "?refresh=1" : ""));
  document.getElementById("count").textContent = d.count;
  if (!d.accounts.length) { document.getElementById("list").innerHTML = '<div class="mut">لا توجد حسابات بعد.</div>'; return; }
  document.getElementById("list").innerHTML = d.accounts.map(a => {
    const qs = a.quota ? Object.entries(a.quota).map(([k, v], gi) =>
      '<div class="qlab"><span class="xfam" data-g="' + gi + '">▸ ' + (NAMES[k] || k) + " (" + (v.modelCount || 0) + ')</span><span>' + pct(v.remainingFraction) + "</span></div>" +
      '<div class="bar ' + bar(v.remainingFraction) + '"><i style="width:' + Math.round((v.remainingFraction || 0) * 100) + '%"></i></div>' +
      '<div class="mut">' + rst(v.resetTime) + "</div>" +
      '<div class="xlist" style="display:none">' + ((v.models || []).map(m =>
        '<div class="mut">· <span dir="ltr">' + m.n + "</span>: " + pct(m.rem) + "</div>"
      ).join("") || '<div class="mut">لا تفصيل — اضغط تحديث.</div>') + "</div>"
    ).join("") : '<div class="mut">لا بيانات كوتة — اضغط تحديث.</div>';
    const opts = TEST_MODELS.map(m => '<option value="' + m + '"' + (m === "gemini-2.5-flash" ? " selected" : "") + ">" + m + "</option>").join("");
    return '<div class="card"><div class="row"><span class="email">' + (a.email || "?") + '</span><span class="proj">' + (a.projectId || "no-project") + "</span></div>" +
      statusLine(a) +
      (a.quotaError ? '<div class="mut">⚠ ' + a.quotaError + "</div>" : qs) +
      '<div class="trow"><select class="tmodel">' + opts + '</select><button class="sec tbtn" data-email="' + (a.email || "") + '">اختبار 🧪</button></div><div class="tres mut"></div>' +
      '<div class="trow arow"><button class="sec abtn-t" data-email="' + (a.email || "") + '">' + (a.enabled === false ? "تشغيل ▶" : "إيقاف ⏸") + '</button><button class="sec abtn-x" data-email="' + (a.email || "") + '">حذف 🗑</button><span class="mut ares"></span></div></div>';
  }).join("");
  document.querySelectorAll(".xfam").forEach(s => s.onclick = () => {
    const x = s.closest(".card").querySelectorAll(".xlist")[Number(s.dataset.g)];
    if (!x) return;
    const open = x.style.display !== "none";
    x.style.display = open ? "none" : "block";
    s.innerHTML = (open ? "▸ " : "▾ ") + s.innerHTML.slice(2);
  });
  document.querySelectorAll(".tbtn").forEach(b => b.onclick = async () => {
    const card = b.closest(".card");
    const box = card.querySelector(".tres");
    const model = card.querySelector(".tmodel").value;
    b.disabled = true; box.innerHTML = "⏳ يختبر " + model + " على ٣ مسارات…";
    try {
      const d = await api("/api/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: b.dataset.email, model }) });
      if (!d.results) { box.innerHTML = '<span class="tbad">❌ ' + (d.error || "فشل") + "</span>"; }
      else {
        box.innerHTML = d.results.map(r =>
          "<div>" + r.endpoint + ": <b>" + r.status + "</b> " +
          (r.ok ? '<span class="tok">✅ ' + r.ms + "ms</span>" : '<span class="tbad">✖</span> <span class="mut">' + (r.detail || "").slice(0, 90) + "</span>") + "</div>"
        ).join("") + "<div><b>" + d.verdict + "</b></div>";
      }
    } catch { box.innerHTML = '<span class="tbad">❌ انقطع الاتصال</span>'; }
    b.disabled = false;
  });
  document.querySelectorAll(".abtn-t").forEach(b => b.onclick = async () => {
    const card = b.closest(".card");
    const out = card.querySelector(".ares");
    b.disabled = true; out.textContent = "⏳…";
    try {
      const d = await api("/api/accounts/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: b.dataset.email }) });
      if (d.ok) { out.textContent = d.enabled ? "✅ مُفعّل — أعد تشغيل الحاوية" : "⏸ أُوقف — أعد تشغيل الحاوية"; await load(false); }
      else out.innerHTML = '<span class="tbad">❌ ' + (d.error || "فشل") + "</span>";
    } catch { out.innerHTML = '<span class="tbad">❌ انقطع الاتصال</span>'; }
    b.disabled = false;
  });
  document.querySelectorAll(".abtn-x").forEach(b => b.onclick = async () => {
    const card = b.closest(".card");
    const out = card.querySelector(".ares");
    if (!confirm("حذف الحساب " + b.dataset.email + " نهائيًا؟")) return;
    b.disabled = true; out.textContent = "⏳…";
    try {
      const d = await api("/api/accounts/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: b.dataset.email }) });
      if (d.ok) { out.textContent = "🗑 حُذف — المتبقي " + d.count; await load(false); }
      else out.innerHTML = '<span class="tbad">❌ ' + (d.error || "فشل") + "</span>";
    } catch { out.innerHTML = '<span class="tbad">❌ انقطع الاتصال</span>'; }
    b.disabled = false;
  });
}
const TEST_MODELS = ["gemini-2.5-flash", "gemini-3-flash", "gemini-3.8-flash", "gemini-3.8-flash-tiered", "gemini-2.5-pro", "gemini-3.1-pro"];
document.getElementById("refresh").onclick = e => { e.target.disabled = true; load(true).finally(() => e.target.disabled = false); };
async function loadGuard() {
  try {
    const d = await api("/api/guard");
    document.getElementById("guardVal").textContent = d.disabled ? "معطّل" : d.value + "٪";
    document.querySelectorAll(".gbtn").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === d.value));
  } catch {}
}
document.querySelectorAll(".gbtn").forEach(b => b.onclick = async () => {
  const m = document.getElementById("guardMsg");
  m.className = "msg ok"; m.textContent = "جارٍ الحفظ…";
  try {
    const d = await api("/api/guard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: Number(b.dataset.v) }) });
    if (d.value) { m.textContent = "✅ أصبح " + (d.disabled ? "معطلًا" : d.value + "٪"); loadGuard(); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error || "فشل"); }
  } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
});
loadGuard();
document.getElementById("pjBtn").onclick = async e => {
  const m = document.getElementById("mkdirMsg");
  const v = document.getElementById("pjname").value.trim();
  if (!v) { m.className = "msg err"; m.textContent = "❌ اكتب اسم المشروع أولًا"; return; }
  const btn = e.target; btn.disabled = true; m.className = "msg ok"; m.textContent = "⏳ ينشئ المجلد والجلسة…";
  try {
    const d = await api("/api/newproject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v }) });
    if (d.ok) { m.className = "msg ok"; m.textContent = "✅ مشروع " + d.name + " جاهز — مجلد + جلسة مرتبطة. افتح أوبن كود وستجد الجلسة."; document.getElementById("pjname").value = ""; loadDirs(); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error || "فشل"); }
  } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
  btn.disabled = false;
};
document.getElementById("mkdirBtn").onclick = async e => {
  const m = document.getElementById("mkdirMsg");
  const v = document.getElementById("mdir").value.trim();
  if (!v) { m.className = "msg err"; m.textContent = "❌ اكتب اسم المجلد أولًا"; return; }
  const btn = e.target; btn.disabled = true; m.className = "msg ok"; m.textContent = "⏳ جارٍ الإنشاء…";
  try {
    const d = await api("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v }) });
    if (d.ok) { m.className = "msg ok"; m.textContent = "✅ أُنشئ مجلد: " + d.name; document.getElementById("mdir").value = ""; loadDirs(); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error === "exists" ? "المجلد موجود مسبقًا" : (d.error || "فشل")); }
  } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
  btn.disabled = false;
};
async function loadDirs() {
  const box = document.getElementById("dirList");
  try {
    const d = await api("/api/dirs");
    if (!d.dirs.length) { box.innerHTML = "📂 المشاريع الحالية (0): لا شيء بعد"; return; }
    box.innerHTML = "📂 المشاريع الحالية (" + d.dirs.length + "): " + d.dirs.map(x =>
      '<div class="orow"><span dir="ltr">' + x.name + " " + (x.sessions.length ? "🟢" + x.sessions.length : "⚪") + '</span><span><button class="sec obtn" data-d="' + x.name.replace(/"/g, "&quot;") + '">🚀 افتح</button> <button class="sec dbtn" data-d="' + x.name.replace(/"/g, "&quot;") + '">🗑</button></span></div>' +
      x.sessions.map(s => '<div class="srow"><span>💬 ' + (s.title || s.id).slice(0, 40) + '</span><button class="sec cbtn" data-id="' + s.id + '">🗑 حذف</button></div>').join("")
    ).join("");
    box.querySelectorAll(".obtn").forEach(b => b.onclick = async () => {
      const m = document.getElementById("mkdirMsg");
      b.disabled = true; m.className = "msg ok"; m.textContent = "⏳ يفتح " + b.dataset.d + " في أوبن كود…";
      try {
        const r = await api("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.d }) });
        m.className = r.ok ? "msg ok" : "msg err";
        m.textContent = r.ok ? "✅ أُضيف — افتح أوبن كود وستجد جلسة جديدة في " + r.name : "❌ " + (r.error || "فشل");
        if (r.ok) loadDirs();
      } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
      b.disabled = false;
    });
    box.querySelectorAll(".dbtn").forEach(b => b.onclick = async () => {
      const m = document.getElementById("mkdirMsg");
      if (!confirm("حذف مجلد " + b.dataset.d + "؟ (فقط إن كان فارغًا)")) return;
      b.disabled = true; m.className = "msg ok"; m.textContent = "⏳ جارٍ حذف المجلد…";
      try {
        const r = await api("/api/rmdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.d }) });
        m.className = r.ok ? "msg ok" : "msg err";
        m.textContent = r.ok ? "✅ حُذف المجلد" : "❌ " + (r.error === "not empty" ? "المجلد غير فارغ — فرّغه أولًا" : (r.error || "فشل"));
        if (r.ok) loadDirs();
      } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
      b.disabled = false;
    });
    box.querySelectorAll(".cbtn").forEach(b => b.onclick = async () => {
      const m = document.getElementById("mkdirMsg");
      if (!confirm("حذف هذه الجلسة نهائيًا؟")) return;
      b.disabled = true; m.className = "msg ok"; m.textContent = "⏳ جارٍ حذف الجلسة…";
      try {
        const r = await api("/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.id }) });
        m.className = r.ok ? "msg ok" : "msg err";
        m.textContent = r.ok ? "✅ حُذفت الجلسة" : "❌ " + (r.error || "فشل");
        if (r.ok) loadDirs();
      } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
      b.disabled = false;
    });
  } catch { box.innerHTML = "❌ تعذر تحميل المجلدات"; }
}
loadDirs();
document.getElementById("start").onclick = async e => {
  e.target.disabled = true;
  const d = await api("/api/login/start", { method: "POST" });
  e.target.disabled = false;
  if (!d.url) return;
  document.getElementById("loginArea").style.display = "block";
  document.getElementById("oauthLink").href = d.url;
};
async function doLoginFinish(rawInput) {
  const m = document.getElementById("loginMsg");
  const t = (rawInput || "").trim();
  if (!t) {
    m.className = "msg err";
    m.textContent = "❌ الحافظة فارغة أو لم يتم إدخال الرابط. انسخ رابط صفحة الخطأ ثم حاول مجددًا.";
    return;
  }
  document.getElementById("cb").value = t;
  const btn1 = document.getElementById("pasteFinish");
  const btn2 = document.getElementById("finish");
  if (btn1) btn1.disabled = true;
  if (btn2) btn2.disabled = true;
  m.className = "msg ok"; m.textContent = "⏳ جارٍ التبادل مع Google… قد يستغرق حتى دقيقة، لا تغلق الصفحة.";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const d = await api("/api/login/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: t }), signal: ctrl.signal });
    clearTimeout(timer);
    if (d.ok) { m.className = "msg ok"; m.textContent = "✅ تمت إضافة " + (d.email || "الحساب") + (d.project ? " | المشروع: " + d.project : ""); document.getElementById("cb").value = ""; load(false); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error || "فشل"); }
  } catch (err) {
    clearTimeout(timer);
    m.className = "msg err";
    m.textContent = err && err.name === "AbortError"
      ? "⏱ انتهت المهلة (دقيقتان) — غالبًا نفق Termius انقطع. أعد الاتصال ثم اضغط إتمام مجددًا."
      : "❌ انقطع الاتصال بالسيرفر — تحقق أن Termius متصل ثم أعد المحاولة.";
  }
  if (btn1) btn1.disabled = false;
  if (btn2) btn2.disabled = false;
}
document.getElementById("pasteFinish").onclick = async () => {
  const m = document.getElementById("loginMsg");
  let clip = "";
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      clip = await navigator.clipboard.readText();
    }
  } catch {}
  if (!clip) clip = document.getElementById("cb").value.trim();
  if (!clip) {
    m.className = "msg err";
    m.textContent = "⚠ تعذر قراءة الحافظة تلقائيًا. يُرجى لصق الرابط يدويًا في المربع أدناه.";
    const det = document.querySelector("#loginArea details");
    if (det) det.open = true;
    document.getElementById("cb").focus();
    return;
  }
  await doLoginFinish(clip);
};
document.getElementById("finish").onclick = () => doLoginFinish(document.getElementById("cb").value);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    const area = document.getElementById("loginArea");
    if (area && area.style.display !== "none") {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const clip = (await navigator.clipboard.readText()).trim();
          if (clip && (clip.includes("oauth-callback") || clip.includes("code="))) {
            const cb = document.getElementById("cb");
            if (!cb.value) {
              cb.value = clip;
              const m = document.getElementById("loginMsg");
              m.className = "msg ok";
              m.textContent = "💡 تم اكتشاف الرابط في الحافظة! اضغط زر اللصق والإتمام فورًا.";
            }
          }
        }
      } catch {}
    }
  }
});
load(false);
loadProxies();
refreshCheckStatus();
document.querySelectorAll(".tabbtn").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabbtn").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tabsec").forEach(x => x.classList.toggle("on", x.id === "tab-" + b.dataset.t));
  if (b.dataset.t === "sess") loadSessions();
  if (b.dataset.t === "pol") loadPKeys();
  if (b.dataset.t === "cc") loadCcKeys();
  if (b.dataset.t === "proxy") { loadProxies(); loadQuarantine(); refreshCheckStatus(); }
});
async function loadPKeys() {
  const box = document.getElementById("plist");
  box.innerHTML = '<div class="mut">جارٍ التحميل…</div>';
  const badge = s => s === "ok" ? "🟢 سليم" : s === "temp" ? "⏳ Pollinations معطّلة مؤقتًا" : s === "limited" ? "🟡 محدود الصلاحيات" : s === "invalid" ? "🔴 مرفوض" : "⚠ تعذّر الفحص";
  try {
    const d = await api("/api/pkeys");
    document.getElementById("pcount").textContent = d.count;
    if (!d.keys.length) { box.innerHTML = '<div class="mut">لا مفاتيح بعد — أضف الأول أعلاه.</div>'; return; }
    const tempNote = d.keys.some(k => k.status === "temp")
      ? '<div class="mut">⏳ خطأ في خادم Pollinations الآن (مؤقّت). المفاتيح سليمة، والتحقق يتكرر تلقائيًا كل 5 دقائق.</div>' : "";
    box.innerHTML = tempNote + d.keys.map(k => {
      const ub = k.usage ? '<div class="mut">📊 الاستهلاك: ' + k.usage.reqs + ' طلب · $' + k.usage.cost + '</div>' +
        k.usage.top.map(t => '<div class="mut">· <span dir="ltr">' + t.model + '</span>: ' + t.reqs + ' طلب · ' + t.tokens + ' 🔤</div>').join("") : "";
      return '<div class="card"><div class="row"><span class="email">' + k.name + (k.active ? " ✅ نشط" : "") + '</span><span><button class="sec pact" data-n="' + k.name.replace(/"/g, "&quot;") + '">تفعيل</button> <button class="sec pdel" data-n="' + k.name.replace(/"/g, "&quot;") + '">🗑</button></span></div>' +
      '<div class="proj"><span dir="ltr">' + k.masked + '</span>' + (k.user ? " · " + k.user : "") + '</div>' +
      '<div class="mut">' + badge(k.status) + ((k.balance !== null && k.balance !== undefined) ? " · 🌻 " + k.balance : "") + (k.note ? " · " + k.note : "") + '</div>' + ub + '</div>';
    }).join("");
    box.querySelectorAll(".pact").forEach(b => b.onclick = async () => {
      const m = document.getElementById("pmsg");
      b.disabled = true;
      try {
        const r = await api("/api/pkeys/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.n }) });
        m.className = r.ok ? "msg ok" : "msg err";
        m.textContent = r.ok ? "✅ أصبح " + r.name + " نشطًا" : "❌ " + (r.error || "فشل");
        if (r.ok) loadPKeys();
      } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
      b.disabled = false;
    });
    box.querySelectorAll(".pdel").forEach(b => b.onclick = async () => {
      const m = document.getElementById("pmsg");
      if (!confirm("حذف مفتاح " + b.dataset.n + "؟")) return;
      b.disabled = true;
      try {
        const r = await api("/api/pkeys", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.n }) });
        m.className = r.ok ? "msg ok" : "msg err";
        m.textContent = r.ok ? "✅ حُذف" : "❌ " + (r.error || "فشل");
        if (r.ok) loadPKeys();
      } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
      b.disabled = false;
    });
  } catch { box.innerHTML = '<div class="mut">❌ تعذر التحميل</div>'; }
}
document.getElementById("paddBtn").onclick = async e => {
  const m = document.getElementById("pmsg");
  const name = document.getElementById("pname").value.trim();
  const key = document.getElementById("pkey").value.trim();
  if (!name || !key) { m.className = "msg err"; m.textContent = "❌ اكتب الاسم والمفتاح"; return; }
  const btn = e.target; btn.disabled = true; m.className = "msg ok"; m.textContent = "⏳ يتحقق من المفتاح…";
  try {
    const d = await api("/api/pkeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, key }) });
    if (d.ok) { m.className = "msg ok"; m.textContent = "✅ أُضيف " + d.name + (d.status === "temp" || d.status === "error" ? " (سيُتحقق تلقائيًا بعد عودة الخدمة)" : " (" + d.status + ")"); document.getElementById("pname").value = ""; document.getElementById("pkey").value = ""; loadPKeys(); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error === "key rejected" ? "المفتاح مرفوض من Pollinations" : d.error === "bad key" ? "صيغة المفتاح خاطئة" : (d.error || "فشل")); }
  } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
  btn.disabled = false;
};
document.getElementById("prefresh").onclick = () => loadPKeys();
async function loadCcKeys() {
  const box = document.getElementById("cclist");
  box.innerHTML = '<div class="mut">جارٍ التحميل…</div>';
  const badge = s => s === "ok" ? "🟢 سليم" : s === "invalid" ? "🔴 مرفوض" : "⚠ خطأ";
  try {
    const d = await api("/api/cckeys");
    document.getElementById("cccount").textContent = d.count;
    if (!d.keys.length) { box.innerHTML = '<div class="mut">لا مفاتيح بعد — أضف الأول أعلاه.</div>'; return; }
    box.innerHTML = d.keys.map(k =>
      '<div class="card"><div class="row"><span class="email">' + k.name + '</span><span><button class="sec ccdel" data-n="' + k.name.replace(/"/g, "&quot;") + '">🗑</button></span></div>' +
      '<div class="proj"><span dir="ltr">' + k.masked + '</span>' + (k.models ? " · " + k.models + " موديل" : "") + '</div>' +
      '<div class="mut">' + badge(k.status) + '</div></div>'
    ).join("");
    box.querySelectorAll(".ccdel").forEach(b => b.onclick = async () => {
      const m = document.getElementById("ccmsg");
      if (!confirm("حذف مفتاح " + b.dataset.n + "؟")) return;
      b.disabled = true;
      try {
        const r = await api("/api/cckeys", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.n }) });
        m.className = r.ok ? "msg ok" : "msg err";
        m.textContent = r.ok ? "✅ حُذف" : "❌ " + (r.error || "فشل");
        if (r.ok) loadCcKeys();
      } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
      b.disabled = false;
    });
  } catch { box.innerHTML = '<div class="mut">❌ تعذر التحميل</div>'; }
}
document.getElementById("ccaddBtn").onclick = async e => {
  const m = document.getElementById("ccmsg");
  const name = document.getElementById("ccname").value.trim();
  const key = document.getElementById("cckey").value.trim();
  if (!name || !key) { m.className = "msg err"; m.textContent = "❌ اكتب الاسم والمفتاح"; return; }
  const btn = e.target; btn.disabled = true; m.className = "msg ok"; m.textContent = "⏳ يتحقق من المفتاح…";
  try {
    const d = await api("/api/cckeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, key }) });
    if (d.ok) { m.className = "msg ok"; m.textContent = "✅ أُضيف " + d.name + " (" + d.models + " موديل)"; document.getElementById("ccname").value = ""; document.getElementById("cckey").value = ""; loadCcKeys(); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error === "key rejected" ? "المفتاح مرفوض من CodeCraft" : d.error === "bad key" ? "صيغة المفتاح خاطئة (يبدأ بـ cc_)" : (d.error || "فشل")); }
  } catch { m.className = "msg err"; m.textContent = "❌ خطأ اتصال"; }
  btn.disabled = false;
};
document.getElementById("ccrefresh").onclick = () => loadCcKeys();
async function loadSessions() {
  const box = document.getElementById("slist");
  box.innerHTML = '<div class="mut">جارٍ التحميل…</div>';
  try {
    const d = await api("/api/sessions");
    const showChild = document.getElementById("showChild").checked;
    const list = showChild ? d.sessions : d.sessions.filter(s => !s.child);
    document.getElementById("scount").textContent = list.length + " / " + d.count;
    if (!list.length) { box.innerHTML = '<div class="mut">لا توجد جلسات.</div>'; return; }
    const f = t => { if (!t) return ""; try { return new Date(t).toLocaleString("ar") } catch { return "" } };
    box.innerHTML = list.map(s =>
      '<div class="card"><div class="row"><span class="email">' + (s.child ? "🌿 " : "") + (s.title || s.id).slice(0, 50) + '</span><button class="sec cbtn2" data-id="' + s.id + '">🗑</button></div>' +
      '<div class="proj">📁 <span dir="ltr">' + String(s.directory || "").replace("/workspace/", "") + '</span></div>' +
      '<div class="mut">🤖 ' + (s.agent || "؟") + ' · 🧠 <span dir="ltr">' + (s.model || "؟") + '</span> · 🔤 ' + s.tokens + ' · 💰 $' + Number(s.cost || 0).toFixed(4) + '</div>' +
      '<div class="mut">🕐 ' + f(s.updated) + '</div></div>'
    ).join("");
    box.querySelectorAll(".cbtn2").forEach(b => b.onclick = async () => {
      if (!confirm("حذف هذه الجلسة نهائيًا؟")) return;
      b.disabled = true;
      try {
        const r = await api("/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.id }) });
        if (r.ok) { loadSessions(); loadDirs(); } else alert("❌ " + (r.error || "فشل"));
      } catch { alert("❌ خطأ اتصال"); }
      b.disabled = false;
    });
  } catch { box.innerHTML = '<div class="mut">❌ تعذر التحميل</div>'; }
}
document.getElementById("srefresh").onclick = () => loadSessions();
document.getElementById("showChild").onchange = () => loadSessions();

/* ---------- 🌐 البروكسيات ---------- */
let proxyPoolCount = 0;
let proxyQuarantinedCount = 0;
function updateProxyCountLabel() {
  const el = document.getElementById("proxyCount");
  if (!el) return;
  el.textContent = proxyPoolCount + (proxyQuarantinedCount ? " (" + proxyQuarantinedCount + " محجور)" : "");
}
function proxyMsg(text, ok) {
  const m = document.getElementById("proxyMsg");
  m.className = ok ? "msg ok" : "msg err";
  m.textContent = text;
}
async function loadQuarantine() {
  const card = document.getElementById("proxyQuarantineCard");
  if (!card) return;
  try {
    const d = await api("/api/proxies/quarantine");
    const n = d.count || 0;
    proxyQuarantinedCount = n;
    document.getElementById("proxyQuarantineCount").textContent = n;
    card.style.display = n ? "block" : "none";
    const list = document.getElementById("proxyQuarantineList");
    if (!n) { list.innerHTML = ""; updateProxyCountLabel(); return; }
    list.innerHTML = d.quarantined.map(q => {
      const left = Math.max(0, Math.round((q.until - Date.now()) / 60000));
      return '<div class="pxline"><span>' + q.masked + '</span><span>🔒 ' + (q.reason || "—") +
        ' — يخرج بعد ' + left + ' د</span></div>';
    }).join("");
    updateProxyCountLabel();
  } catch { /* the panel keeps working without the quarantine list */ }
}
async function loadProxies() {
  const box = document.getElementById("proxyList");
  const btn = document.getElementById("proxyToggleBtn");
  if (!box) return;
  try {
    const d = await api("/api/proxies");
    proxyPoolCount = d.count;
    updateProxyCountLabel();
    loadQuarantine();
    btn.textContent = d.enabled ? "🟢 نفق CONNECT مفعّل" : "⚪ نفق CONNECT معطّل";
    btn.style.background = d.enabled ? "#065f46" : "#7f1d1d";
    btn.title = d.tunnel?.proxy ? "الحاوية: " + (d.tunnel.container || "?") + " · " + d.tunnel.proxy : "";
    const rb = document.getElementById("proxyRollbackBtn");
    if (rb) rb.style.display = d.enabled ? "" : "none";
    if (!d.proxies.length) { box.innerHTML = '<div class="mut">لا بروكسيات — أضف واحدًا من الأعلى.</div>'; return; }
    box.innerHTML = d.proxies.map(p =>
      '<div class="card pxcard"><div class="row">' +
      '<span class="pxurl">' + p.masked + '</span>' +
      '<span class="pxacts">' +
      '<button class="sec pxtest" data-id="' + p.id + '">🧪 اختبار</button>' +
      '<button class="sec pxdel" data-id="' + p.id + '" style="background:#7f1d1d">🗑</button>' +
      '</span></div>' +
      '<div class="mut pxres" data-id="' + p.id + '"></div></div>'
    ).join("");
    box.querySelectorAll(".pxdel").forEach(b => b.onclick = async () => {
      if (!confirm("حذف هذا البروكسي من المسبح؟")) return;
      b.disabled = true;
      try {
        const r = await api("/api/proxies", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: Number(b.dataset.id) }) });
        if (r.ok) { proxyMsg("🗑 تم حذف البروكسي (" + r.count + " متبقٍ)", true); loadProxies(); }
        else proxyMsg("❌ " + (r.error || "فشل الحذف"), false);
      } catch { proxyMsg("❌ خطأ اتصال", false); }
      b.disabled = false;
    });
    box.querySelectorAll(".pxtest").forEach(b => b.onclick = async () => {
      b.disabled = true;
      const out = box.querySelector('.pxres[data-id="' + b.dataset.id + '"]');
      if (out) out.textContent = "⏳ جارٍ الاختبار…";
      try {
        const r = await api("/api/proxies/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: Number(b.dataset.id) }) });
        if (out) out.innerHTML = r.ok
          ? '🟢 IP: <span dir="ltr">' + r.ip + '</span> · ' + r.ms + 'ms'
          : '🔴 فشل: ' + (r.error || "غير معروف");
      } catch { if (out) out.textContent = "🔴 خطأ اتصال"; }
      b.disabled = false;
    });
  } catch { box.innerHTML = '<div class="mut">❌ تعذر تحميل البروكسيات</div>'; }
}
document.getElementById("proxyRefresh").onclick = () => loadProxies();
document.getElementById("proxyToggleBtn").onclick = async () => {
  const btn = document.getElementById("proxyToggleBtn");
  const cur = btn.textContent.includes("مفعّل");
  const want = !cur;
  const msg = want
    ? "سيُعاد إنشاء حاوية opencode-server لتفعيل نفق CONNECT.\nانقطاع متوقّع ~30 ثانية.\n\nهل تريد المتابعة؟"
    : "سيُعاد إنشاء حاوية opencode-server لإزالة نفق CONNECT.\nانقطاع متوقّع ~30 ثانية.\n\nهل تريد المتابعة؟";
  if (!confirm(msg)) return;
  btn.disabled = true;
  try {
    const r = await api("/api/proxies/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: want }) });
    if (r.ok && r.unchanged) { proxyMsg("ℹ️ الحالة كما هي — لم يتغيّر شيء", true); loadProxies(); }
    else if (r.ok) {
      proxyMsg("⏳ " + (r.note || "جارٍ إعادة الإنشاء…") , true);
      setTimeout(() => location.reload(), 20000);
    } else proxyMsg("❌ " + (r.error || "فشل التبديل"), false);
  } catch { proxyMsg("❌ انقطع الاتصال — غالباً أُعيد إنشاء الحاوية. أعد تحميل الصفحة.", false); }
  btn.disabled = false;
};
document.getElementById("proxyRollbackBtn").onclick = async () => {
  if (!confirm("التراجع عن آخر إنشاء للنفق والعودة للحاوية السابقة؟\nانقطاع متوقّع ~30 ثانية.")) return;
  try {
    const r = await api("/api/proxies/oc-proxy/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (r.ok) { proxyMsg("⏳ " + (r.note || "جارٍ التراجع…"), true); setTimeout(() => location.reload(), 20000); }
    else proxyMsg("❌ " + (r.error || "فشل التراجع"), false);
  } catch { proxyMsg("❌ انقطع الاتصال — أعد تحميل الصفحة.", false); }
};
document.getElementById("proxyAddBtn").onclick = async () => {
  const ta = document.getElementById("proxyInput");
  const input = ta.value.trim();
  if (!input) { proxyMsg("❌ اكتب بروكسي واحدًا على الأقل", false); return; }
  try {
    const r = await api("/api/proxies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
    if (r.ok) {
      ta.value = "";
      proxyMsg("✅ أُضيف " + r.added + " بروكسي — الإجمالي " + r.count, true);
      loadProxies();
    } else proxyMsg("❌ " + (r.error || "فشل الإضافة"), false);
  } catch { proxyMsg("❌ خطأ اتصال", false); }
};

/* ---------- 🧪 اختبار شامل ---------- */
let proxyTestTimer = null;
function proxyTestMsg(text, ok) {
  const m = document.getElementById("proxyTestMsg");
  m.className = ok ? "msg ok" : "msg err";
  m.textContent = text;
}
function maskProxyUrl(u) {
  try {
    const p = new URL(u);
    const user = decodeURIComponent(p.username || "");
    return p.protocol + "//" + (user ? user + ":***@" : "") + p.hostname + (p.port ? ":" + p.port : "");
  } catch { return u; }
}
// Renders a check snapshot (live or finished) into the panel.
function renderCheckStatus(s) {
  const bar = document.getElementById("proxyBar");
  const fill = document.getElementById("proxyBarFill");
  const stat = document.getElementById("proxyStat");
  const prog = document.getElementById("proxyStatProg");
  const cnt = document.getElementById("proxyStatCount");
  if (!s || !s.total) {
    bar.style.display = "none";
    stat.style.display = "none";
    document.getElementById("proxyResultBox").style.display = "none";
    return;
  }
  const pct = s.total ? Math.round((s.tested / s.total) * 100) : 100;
  fill.style.width = pct + "%";
  bar.style.display = s.running ? "block" : "none";
  stat.style.display = "flex";
  prog.textContent = s.running
    ? "جارٍ الفحص… " + s.tested + " / " + s.total + " (" + pct + "٪)"
    : "✅ اكتمل الفحص: " + s.tested + " / " + s.total;
  cnt.textContent = "✅ " + (s.ok || []).length + "  |  🔴 " + (s.failed || []).length;
  const failed = s.failed || [];
  const box = document.getElementById("proxyResultBox");
  const list = document.getElementById("proxyFailList");
  if (!s.running && failed.length) {
    box.style.display = "block";
    list.innerHTML = failed.slice(0, 300).map(f =>
      '<div class="pxline"><span>' + maskProxyUrl(f.url) + '</span><span>🔴 ' + (f.error || "فشل") + '</span></div>'
    ).join("") + (failed.length > 300 ? '<div class="mut">… و ' + (failed.length - 300) + ' فشلاً آخر (يُحذف مع البقية)</div>' : "");
    document.getElementById("proxyPruneBtn").textContent = "🗑 حذف الفاشل (" + failed.length + ")";
  } else {
    box.style.display = "none";
    list.innerHTML = "";
  }
  if (!s.running && s.pruned) {
    document.getElementById("proxyPruneBtn").textContent = "🗑 لا يوجد فاشل";
    prog.textContent = "✅ اكتمل الفحص وتم تنظيف المسبح — المتبقي " + (s.ok || []).length;
  }
}
async function refreshCheckStatus() {
  try {
    const s = await api("/api/proxies/test-all/status");
    renderCheckStatus(s);
    if (s.running && !proxyTestTimer) {
      document.getElementById("proxyTestAllBtn").disabled = true;
      proxyTestTimer = setInterval(pollProxyTest, 1000);
    }
    return s;
  } catch { return null; }
}
async function pollProxyTest() {
  try {
    const s = await api("/api/proxies/test-all/status");
    renderCheckStatus(s);
    if (!s.running) {
      clearInterval(proxyTestTimer);
      proxyTestTimer = null;
      document.getElementById("proxyTestAllBtn").disabled = false;
      const failed = s.failed || [];
      if (failed.length) proxyTestMsg("✅ سليم: " + (s.ok || []).length + " — فاشل: " + failed.length + ". لم يُحذف شيء بعد.", true);
      else proxyTestMsg("✅ كل البروكسيات (" + s.tested + ") سليمة 🎉", true);
      loadProxies();
    }
  } catch {
    clearInterval(proxyTestTimer);
    proxyTestTimer = null;
    document.getElementById("proxyTestAllBtn").disabled = false;
    proxyTestMsg("❌ خطأ اتصال أثناء المتابعة", false);
  }
}
document.getElementById("proxyTestAllBtn").onclick = async () => {
  const btn = document.getElementById("proxyTestAllBtn");
  btn.disabled = true;
  document.getElementById("proxyBar").style.display = "block";
  document.getElementById("proxyStat").style.display = "flex";
  document.getElementById("proxyBarFill").style.width = "0%";
  document.getElementById("proxyStatProg").textContent = "جارٍ البدء…";
  document.getElementById("proxyStatCount").textContent = "";
  document.getElementById("proxyResultBox").style.display = "none";
  proxyTestMsg("⏳ بدأ فحص كل البروكسيات…", true);
  try {
    const r = await api("/api/proxies/test-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.started) { proxyTestMsg("⚠️ " + (r.reason || "تعذر البدء"), false); btn.disabled = false; return; }
    if (proxyTestTimer) clearInterval(proxyTestTimer);
    proxyTestTimer = setInterval(pollProxyTest, 1000);
    pollProxyTest();
  } catch { proxyTestMsg("❌ خطأ اتصال", false); btn.disabled = false; }
};
document.getElementById("proxyQuarantineClearBtn").onclick = async () => {
  const btn = document.getElementById("proxyQuarantineClearBtn");
  if (!confirm("إرجاع كل البروكسيات المحجورة إلى المسبح؟")) return;
  btn.disabled = true;
  try {
    const r = await api("/api/proxies/quarantine/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (r.ok) {
      proxyMsg("↩ أعيد " + r.cleared + " بروكسي إلى المسبح", true);
      loadQuarantine();
    } else proxyMsg("❌ " + (r.error || "فشل الإرجاع"), false);
  } catch { proxyMsg("❌ خطأ اتصال", false); }
  btn.disabled = false;
};

document.getElementById("proxyPruneBtn").onclick = async () => {
  const btn = document.getElementById("proxyPruneBtn");
  if (!confirm("حذف كل البروكسيات الفاشلة من المسبح؟\\n\\nسيتم حفظ نسخة احتياطية قبل الحذف.")) return;
  btn.disabled = true;
  try {
    const r = await api("/api/proxies/prune", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (r.ok) {
      if (r.alreadyClean) {
        proxyTestMsg("✅ " + (r.message || "المسبح نظيف — لا يوجد فاشل"), true);
      } else {
        proxyTestMsg("🗑 حُذف " + r.removed + " بروكسي فاشل — المتبقي " + r.count + (r.backup ? " (نسخة احتياطية: " + r.backup.split("/").pop() + ")" : ""), true);
      }
      document.getElementById("proxyResultBox").style.display = "none";
      document.getElementById("proxyPruneBtn").textContent = "🗑 لا يوجد فاشل";
      loadProxies();
      refreshCheckStatus();
    } else proxyTestMsg("❌ " + (r.error || "فشل الحذف"), false);
  } catch { proxyTestMsg("❌ خطأ اتصال", false); }
  btn.disabled = false;
};
</script></body></html>`;

const GUEST_PAGE = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>إضافة حساب Antigravity</title>
<style>
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}
body{font-family:system-ui,sans-serif;background:#0f1420;color:#e8ecf4;margin:0;padding:14px;max-width:640px;margin-inline:auto;width:100%}
h1{font-size:20px;margin:8px 0 2px}h2{font-size:16px;margin:18px 0 8px;color:#9fb4d8}
.sub{color:#8b93a7;font-size:13px;margin-bottom:12px}
.card{background:#1a2233;border:1px solid #2a3550;border-radius:12px;padding:12px;margin:10px 0;min-width:0}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;flex-wrap:wrap;min-width:0}
.email{font-weight:700;min-width:0;overflow-wrap:anywhere;word-break:break-word}.proj{color:#8b93a7;font-size:12px;direction:ltr;overflow-wrap:anywhere;word-break:break-word}
.bar{height:10px;background:#2a3550;border-radius:6px;overflow:hidden;margin:4px 0 2px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#34d399,#10b981);border-radius:6px}
.bar.low>i{background:linear-gradient(90deg,#fbbf24,#f59e0b)}.bar.zero>i{background:#ef4444}
.qlab{font-size:12px;color:#9fb4d8;display:flex;justify-content:space-between}
button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 16px;font-size:15px;width:100%;margin-top:8px;cursor:pointer}
button.sec{background:#2a3550}button:disabled{opacity:.5}
a.btn{display:block;text-align:center;background:#059669;color:#fff;border-radius:10px;padding:12px;font-size:15px;text-decoration:none;margin-top:8px}
textarea{width:100%;max-width:100%;min-height:90px;background:#0b101c;color:#e8ecf4;border:1px solid #2a3550;border-radius:10px;padding:10px;font-size:13px;direction:ltr}
ol{font-size:13px;color:#c6cfdf;line-height:1.9;padding-inline-start:20px}
.msg{border-radius:10px;padding:10px;margin-top:8px;font-size:14px;display:none}
.msg.ok{display:block;background:#064e3b}.msg.err{display:block;background:#7f1d1d}
.mut{font-size:12px;color:#8b93a7}
.stline{font-size:11px;color:#8b93a7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xfam{cursor:pointer}
.xlist{column-count:1;margin-top:2px}
.xlist .mut{margin:0;font-size:11px;line-height:1.7;break-inside:avoid}
@media(min-width:700px){.xlist{column-count:2;column-gap:14px}}
</style></head><body>
<h1>➕ إضافة حساب Google</h1>
<div class="sub">سجّل بحسابك وسيُضاف للاستخدام المشترك — لن ترى أي حسابات أخرى</div>

<div id="mine"></div>

<h2>خطوات الإضافة</h2>
<div class="card">
<button id="start">١) توليد رابط الدخول</button>
<div id="loginArea" style="display:none">
<ol>
<li>افتح الرابط التالي في نفس المتصفح وسجّل بحساب Google ووافق:</li>
</ol>
<a class="btn" id="oauthLink" href="#" target="_blank" rel="noopener">فتح صفحة الدخول ←</a>
<ol start="2">
<li>بعد الموافقة ستظهر صفحة خطأ (<span dir="ltr">localhost:51121</span>) — طبيعي تمامًا. انسخ الرابط كاملًا من شريط العنوان.</li>
<li>ارجع هنا واضغط الزر المباشر أدناه (سيقرأ الحافظة وينهي الربط فورًا):</li>
</ol>
<button id="pasteFinish" class="btn" style="background:#059669;margin-top:4px">📋 لصق الرابط من الحافظة وإتمام فورًا</button>
<details style="margin-top:12px">
<summary class="mut" style="cursor:pointer">أو الصق يدويًا هنا إذا تعذر الوصول للحافظة ▼</summary>
<textarea id="cb" style="margin-top:6px" placeholder="http://localhost:51121/oauth-callback?code=…"></textarea>
<button id="finish" class="sec">إتمام تسجيل الدخول يدويًا</button>
</details>
<div class="msg" id="loginMsg"></div>
</div></div>

<script>
const T = new URLSearchParams(location.search).get("token") || "";
const api = (p, o) => fetch(p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(T), o).then(r => r.json());
const pct = f => (f === undefined || f === null) ? "؟" : Math.round(f * 100) + "٪";
const bar = f => f === undefined ? "" : (f <= 0 ? "zero" : (f < 0.3 ? "low" : ""));
const rst = t => { if (!t) return ""; try { const d = new Date(t); return "تصفير: " + d.toLocaleString("ar") } catch { return t } };
const NAMES = { "gemini-flash": "⚡ Gemini Flash", "gemini-pro": "🧠 Gemini Pro", "claude": "🟠 Claude" };
const famName = f => f === "claude" ? "Claude" : "Gemini";
const dt = t => { try { return new Date(t).toLocaleString("ar", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) } catch { return "" } };
function statusLine(a) {
  const parts = [];
  if (a.enabled === false) parts.push("⏸ معطّل");
  if (a.active && a.active.length) parts.push("🟢 " + a.active.map(famName).join("+"));
  if (a.limitedUntil) parts.push("⏳ " + (a.limitedScope || []).map(famName).join("+") + " حتى " + dt(a.limitedUntil));
  parts.push(a.lastUsed ? "· " + dt(a.lastUsed) : "جديد");
  return '<div class="stline">' + parts.join(" · ") + "</div>";
}

async function loadMine(live) {
  const d = await api("/api/mine" + (live ? "?refresh=1" : ""));
  const box = document.getElementById("mine");
  if (!d.account) { box.innerHTML = ""; return; }
  const a = d.account;
  const qs = a.quota ? Object.entries(a.quota).map(([k, v], gi) =>
    '<div class="qlab"><span class="xfam" data-g="' + gi + '">▸ ' + (NAMES[k] || k) + " (" + (v.modelCount || 0) + ')</span><span>' + pct(v.remainingFraction) + "</span></div>" +
    '<div class="bar ' + bar(v.remainingFraction) + '"><i style="width:' + Math.round((v.remainingFraction || 0) * 100) + '%"></i></div>' +
    '<div class="mut">' + rst(v.resetTime) + "</div>" +
    '<div class="xlist" style="display:none">' + ((v.models || []).map(m =>
      '<div class="mut">· <span dir="ltr">' + m.n + "</span>: " + pct(m.rem) + "</div>"
    ).join("") || '<div class="mut">لا تفصيل — اضغط تحديث.</div>') + "</div>"
  ).join("") : '<div class="mut">لا بيانات كوتة بعد.</div>';
  box.innerHTML = '<h2>✅ حسابك المضاف</h2><div class="card"><div class="row"><span class="email">' + a.email + '</span><span class="proj">' + (a.projectId || "no-project") + "</span></div>" +
    statusLine(a) +
    (a.quotaError ? '<div class="mut">⚠ ' + a.quotaError + "</div>" : qs) +
    '<button class="sec" id="mref">↻ تحديث كوتتي</button></div>';
  box.querySelectorAll(".xfam").forEach(s => s.onclick = () => {
    const x = s.closest(".card").querySelectorAll(".xlist")[Number(s.dataset.g)];
    if (!x) return;
    const open = x.style.display !== "none";
    x.style.display = open ? "none" : "block";
    s.innerHTML = (open ? "▸ " : "▾ ") + s.innerHTML.slice(2);
  });
  document.getElementById("mref").onclick = e => { e.target.disabled = true; loadMine(true).finally(() => e.target.disabled = false); };
}
document.getElementById("start").onclick = async e => {
  e.target.disabled = true;
  const d = await api("/api/login/start", { method: "POST" });
  e.target.disabled = false;
  if (!d.url) return;
  document.getElementById("loginArea").style.display = "block";
  document.getElementById("oauthLink").href = d.url;
};
async function doLoginFinishGuest(rawInput) {
  const m = document.getElementById("loginMsg");
  const t = (rawInput || "").trim();
  if (!t) {
    m.className = "msg err";
    m.textContent = "❌ الحافظة فارغة أو لم يتم إدخال الرابط. انسخ رابط صفحة الخطأ ثم حاول مجددًا.";
    return;
  }
  document.getElementById("cb").value = t;
  const btn1 = document.getElementById("pasteFinish");
  const btn2 = document.getElementById("finish");
  if (btn1) btn1.disabled = true;
  if (btn2) btn2.disabled = true;
  m.className = "msg ok"; m.textContent = "⏳ جارٍ التبادل مع Google… قد يستغرق حتى دقيقة، لا تغلق الصفحة.";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const d = await api("/api/login/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: t }), signal: ctrl.signal });
    clearTimeout(timer);
    if (d.ok) { m.className = "msg ok"; m.textContent = "✅ تمت إضافة " + (d.email || "الحساب"); document.getElementById("cb").value = ""; loadMine(false); }
    else { m.className = "msg err"; m.textContent = "❌ " + (d.error || "فشل"); }
  } catch (err) {
    clearTimeout(timer);
    m.className = "msg err";
    m.textContent = err && err.name === "AbortError"
      ? "⏱ انتهت المهلة — أعد المحاولة."
      : "❌ انقطع الاتصال بالسيرفر — أعد المحاولة.";
  }
  if (btn1) btn1.disabled = false;
  if (btn2) btn2.disabled = false;
}
document.getElementById("pasteFinish").onclick = async () => {
  const m = document.getElementById("loginMsg");
  let clip = "";
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      clip = await navigator.clipboard.readText();
    }
  } catch {}
  if (!clip) clip = document.getElementById("cb").value.trim();
  if (!clip) {
    m.className = "msg err";
    m.textContent = "⚠ تعذر قراءة الحافظة تلقائيًا. يُرجى لصق الرابط يدويًا في المربع أدناه.";
    const det = document.querySelector("#loginArea details");
    if (det) det.open = true;
    document.getElementById("cb").focus();
    return;
  }
  await doLoginFinishGuest(clip);
};
document.getElementById("finish").onclick = () => doLoginFinishGuest(document.getElementById("cb").value);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    const area = document.getElementById("loginArea");
    if (area && area.style.display !== "none") {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const clip = (await navigator.clipboard.readText()).trim();
          if (clip && (clip.includes("oauth-callback") || clip.includes("code="))) {
            const cb = document.getElementById("cb");
            if (!cb.value) {
              cb.value = clip;
              const m = document.getElementById("loginMsg");
              m.className = "msg ok";
              m.textContent = "💡 تم اكتشاف الرابط في الحافظة! اضغط زر اللصق والإتمام فورًا.";
            }
          }
        }
      } catch {}
    }
  }
});
loadMine(false);
</script></body></html>`;
