#!/usr/bin/env node
// =============================================================================
// recreate-opencode-with-proxy.mjs
// Purpose: recreate the production `opencode-server` container with an
//          HTTPS_PROXY (CONNECT tunnel) added to its environment, keeping
//          EVERY other setting identical (image, cmd, ports, networks,
//          mounts, restart policy), then health-check it and roll back
//          automatically if anything fails.
//
// WHY: Docker's `POST /containers/{id}/update` ignores `Env` (verified:
//      returns 200, Env unchanged) => adding an env var requires a recreate.
//
// USAGE (run from the HOST, or from a helper container with the docker sock):
//   node recreate-opencode-with-proxy.mjs --dry-run     # print plan only
//   node recreate-opencode-with-proxy.mjs                # do it
//   node recreate-opencode-with-proxy.mjs --proxy "http://user:pass@host:port"
//   node recreate-opencode-with-proxy.mjs --smoke opencode/crouton-alpha-free
//
// OPTIONS
//   --name <container>   target container name (default: opencode-server)
//   --proxy <url>        proxy URL for HTTPS_PROXY/HTTP_PROXY
//                        (default: first dc.decodo.com entry in
//                         /root/.config/opencode/opencode_proxies.json)
//   --no-proxy <list>    NO_PROXY list (default: localhost,127.0.0.1,::1,
//                        opencode-server,omniroute,opencd.duckdns.org)
//   --keep-ip            request the same ag-net IPv4 as the old container
//   --smoke <provider/model>  run a real prompt after start to verify
//   --dry-run            print the plan + create payload, change nothing
//   --keep-backup       keep the old container (default: keep, stopped)
//   --rollback          roll back: stop+remove the proxied container and
//                        restore the backup under the original name
// =============================================================================
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

const SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const ARGS = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = ARGS.indexOf("--" + name);
  if (i === -1) return dflt;
  const nxt = ARGS[i + 1];
  return nxt && !nxt.startsWith("--") ? nxt : true;
};
const has = (name) => ARGS.includes("--" + name);

const TARGET = String(flag("name", "opencode-server"));
const DRY = has("dry-run");
const KEEP_IP = has("keep-ip");
const SMOKE = flag("smoke", null);
const ROLLBACK = has("rollback");
// --drop-proxy removes HTTPS_PROXY/HTTP_PROXY from the container environment
// (the tunnel is switched off). --no-proxy stays the NO_PROXY host list.
const DROP_PROXY = has("drop-proxy");
const PROXIES_FILE = "/root/.config/opencode/opencode_proxies.json";

// ---------------------------------------------------------------- docker api
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { socketPath: SOCK, path, method,
        headers: { "X-Api-Version": "1.44", "Content-Type": "application/json",
                   ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let j;
          try { j = JSON.parse(b); } catch { j = { raw: b.slice(0, 300) }; }
          if (res.statusCode >= 400) reject(Object.assign(new Error(method + " " + path + " → " + res.statusCode), { status: res.statusCode, body: j }));
          else resolve(j);
        });
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers
function pickProxy() {
  const given = flag("proxy", null);
  if (given && given !== true) return given;
  if (DROP_PROXY) return null;
  try {
    const j = JSON.parse(fs.readFileSync(PROXIES_FILE, "utf8"));
    const list = (j.proxies || []).filter((p) => /decodo\.com/i.test(p));
    if (list.length) return list[0];
  } catch {}
  throw new Error("no proxy URL given and none found in " + PROXIES_FILE);
}
function maskEnv(env) {
  return env.map((e) => {
    const k = e.split("=")[0];
    const v = e.slice(k.length + 1);
    return /PASS|SECRET|TOKEN|KEY/i.test(k) ? `${k}=***len=${v.length}` : e;
  });
}
function basicAuth(pass) {
  return "Basic " + Buffer.from("opencode:" + pass).toString("base64");
}

// ------------------------------------------------------------- build payload
function buildPayload(old, proxyUrl, noProxyList) {
  const cfg = old.Config || {};
  const hc = old.HostConfig || {};
  const nets = Object.keys(old.NetworkSettings?.Networks || {});
  const primary = hc.NetworkMode && nets.includes(hc.NetworkMode) ? hc.NetworkMode : nets[0];
  const extraNets = nets.filter((n) => n !== primary);

  const env = [...(cfg.Env || [])];
  const setEnv = (k, v) => {
    const i = env.findIndex((e) => e.startsWith(k + "="));
    if (i >= 0) env[i] = k + "=" + v;
    else env.push(k + "=" + v);
  };
  const dropEnv = (k) => {
    const i = env.findIndex((e) => e.startsWith(k + "="));
    if (i >= 0) env.splice(i, 1);
  };
  if (proxyUrl) {
    setEnv("HTTPS_PROXY", proxyUrl);
    setEnv("HTTP_PROXY", proxyUrl);
  } else {
    // --drop-proxy: the tunnel is switched off, the old proxy must not stay.
    dropEnv("HTTPS_PROXY");
    dropEnv("HTTP_PROXY");
  }
  setEnv("NO_PROXY", noProxyList);
  setEnv("no_proxy", noProxyList);

  const binds = (hc.Binds || []).slice();
  for (const m of old.Mounts || []) {
    if (m.Type === "bind" && !binds.some((b) => b.includes(m.Destination))) {
      binds.push(`${m.Source}:${m.Destination}${m.RW ? "" : ":ro"}`);
    }
  }

  const portBindings = {};
  for (const [port, list] of Object.entries(old.NetworkSettings?.Ports || {})) {
    if (list && list.length) portBindings[port] = list.map((x) => ({ HostIp: x.HostIp, HostPort: x.HostPort }));
  }

  const endpoints = {};
  for (const n of extraNets) {
    const ep = old.NetworkSettings?.Networks?.[n] || {};
    // static IP is only requestable on user-defined networks (not bridge/host)
    const canFixIp = KEEP_IP && ep.IPAddress && !["bridge", "host", "none"].includes(n);
    endpoints[n] = canFixIp ? { IPAMConfig: { IPv4Address: ep.IPAddress } } : {};
  }
  // same address for the primary network when it is user-defined
  const primaryNet = old.NetworkSettings?.Networks?.[primary] || {};
  if (KEEP_IP && primaryNet.IPAddress && !["bridge", "host", "none"].includes(primary)) {
    endpoints[primary] = { IPAMConfig: { IPv4Address: primaryNet.IPAddress } };
  }

  const payload = {
    Image: cfg.Image,
    Cmd: cfg.Cmd,
    Entrypoint: cfg.Entrypoint,
    Env: env,
    ExposedPorts: cfg.ExposedPorts || {},
    User: cfg.User || "",
    WorkingDir: cfg.WorkingDir || "/",
    Labels: cfg.Labels || {},
    HostConfig: {
      Binds: binds,
      PortBindings: portBindings,
      RestartPolicy: hc.RestartPolicy || { Name: "unless-stopped" },
      NetworkMode: primary,
      ExtraHosts: hc.ExtraHosts || [],
      ShmSize: hc.ShmSize || 67108864,
      LogConfig: hc.LogConfig || { Type: "json-file", Config: {} },
      Runtime: hc.Runtime || "runc",
      CgroupnsMode: hc.CgroupnsMode || "private",
      IpcMode: hc.IpcMode || "private",
      AutoRemove: false,
      Privileged: !!hc.Privileged,
    },
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
  if (cfg.Hostname && !/^[0-9a-f]{12}$/.test(cfg.Hostname)) payload.Hostname = cfg.Hostname;
  const ips = {};
  for (const n of nets) ips[n] = old.NetworkSettings?.Networks?.[n]?.IPAddress || null;
  return { payload, primary, extraNets, ips };
}

// -------------------------------------------------------------------- health
// Candidate base URLs: when the script runs on the HOST the published port is
// reachable on 127.0.0.1; when it runs inside a peer container (same docker
// network) the container IP is the reachable one.
function candidates(info, payload) {
  const out = [];
  const hostPort = Object.values(payload?.HostConfig?.PortBindings || {})[0]?.[0]?.HostPort;
  const containerPort = Object.keys(info?.Config?.ExposedPorts || {})[0]?.split("/")[0];
  if (hostPort) out.push(`http://127.0.0.1:${hostPort}`);
  for (const ns of Object.values(info?.NetworkSettings?.Networks || {})) {
    if (ns?.IPAddress && containerPort) out.push(`http://${ns.IPAddress}:${containerPort}`);
  }
  return [...new Set(out)];
}

async function probeBase(base, pass, timeoutMs = 8000) {
  try {
    const res = await fetch(`${base}/api/provider?directory=/`, {
      headers: { Authorization: basicAuth(pass) }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return { ok: false, last: "HTTP " + res.status };
    const j = await res.json().catch(() => null);
    const arr = Array.isArray(j?.data) ? j.data : Object.values(j?.data || {});
    const oc = arr.find((x) => x.id === "opencode");
    return { ok: true, baseURL: oc?.settings?.baseURL };
  } catch (e) { return { ok: false, last: e.message }; }
}

async function health(info, payload, pass, timeoutMs = 90_000) {
  const bases = candidates(info, payload);
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    for (const base of bases) {
      const r = await probeBase(base, pass);
      if (r.ok) return { ok: true, base, baseURL: r.baseURL };
      last = `${base} → ${r.last}`;
    }
    await sleep(3000);
  }
  return { ok: false, last };
}

async function smokeTest(base, pass, model) {
  const H = { Authorization: basicAuth(pass), "Content-Type": "application/json" };
  const s = await (await fetch(`${base}/api/session?directory=/`, {
    method: "POST", headers: H, body: JSON.stringify({ title: "proxy-smoke" }),
  })).json();
  const sid = s.id || s.data?.id;
  const [providerID, modelID] = String(model).split("/");
  await fetch(`${base}/api/session/${sid}/prompt`, {
    method: "POST", headers: H, body: JSON.stringify({ model: { providerID, modelID }, text: "Reply with exactly: PONG" }),
  });
  for (let i = 0; i < 14; i++) {
    await sleep(3000);
    const msgs = await (await fetch(`${base}/api/session/${sid}/message`, { headers: H })).json();
    const a = (msgs.data || []).filter((x) => x.type === "assistant").pop();
    if (!a) continue;
    if (a.error) return { ok: false, error: JSON.stringify(a.error).slice(0, 200) };
    if (a.finish) {
      const txt = (a.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      return { ok: a.finish === "stop" && /PONG/i.test(txt), model: `${a.model?.providerID}/${a.model?.id}`, finish: a.finish, tokens: a.tokens, text: txt.slice(0, 80) };
    }
  }
  return { ok: false, error: "timeout waiting for assistant message" };
}

// --------------------------------------------------------------------- main
const proxyUrl = pickProxy();
const noProxyList = String(flag("no-proxy", "localhost,127.0.0.1,::1,opencode-server,omniroute,opencd.duckdns.org"));

if (ROLLBACK) {
  const all = await api("GET", "/containers/json?all=1");
  const backups = all.filter((c) => (c.Names || []).some((n) => n.includes(TARGET + "-pre-proxy")));
  if (!backups.length) { console.error("✗ no backup container found (" + TARGET + "-pre-proxy-*)"); process.exit(1); }
  const b = backups.sort((x, y) => (y.Created || 0) - (x.Created || 0))[0];
  console.log("→ rolling back to", b.Names.join(""));
  // 1) remove the proxied container (if any)
  const cur = await api("GET", `/containers/${TARGET}/json`).catch(() => null);
  if (cur) {
    await api("POST", `/containers/${TARGET}/stop?t=15`).catch(() => {});
    await api("DELETE", `/containers/${TARGET}?force=1`).catch(() => {});
    console.log("  removed proxied container", cur.Id.slice(0, 12));
  }
  // 2) restore the backup under the original name (keep it, do NOT delete)
  await api("POST", `/containers/${b.Id}/rename?name=${TARGET}`);
  await api("POST", `/containers/${TARGET}/start`);
  const restored = await api("GET", `/containers/${TARGET}/json`);
  const rPass = (restored.Config?.Env || []).find((e) => e.startsWith("OPENCODE_SERVER_PASSWORD="))?.split("=").slice(1).join("=") || "";
  const h = await health(restored, { HostConfig: { PortBindings: restored.NetworkSettings?.Ports || {} } }, rPass, 60_000);
  console.log(h.ok ? "✓ rollback done — original container restored, started and healthy" : "✓ rollback done — original container restored and started (health not confirmed: " + h.last + ")");
  process.exit(0);
}

const old = await api("GET", `/containers/${TARGET}/json`);
const oldId = old.Id;
const oldPass = (old.Config?.Env || []).find((e) => e.startsWith("OPENCODE_SERVER_PASSWORD="))?.split("=").slice(1).join("=") || "";
const { payload, primary, extraNets, ips } = buildPayload(old, proxyUrl, noProxyList);

console.log("=== PLAN ===");
console.log("  target        :", TARGET, "(" + oldId.slice(0, 12) + ")");
console.log("  image         :", payload.Image);
console.log("  cmd           :", JSON.stringify(payload.Cmd));
console.log("  ports         :", JSON.stringify(payload.HostConfig.PortBindings));
console.log("  networks      :", [primary, ...extraNets].join(", "));
console.log("  binds         :", payload.HostConfig.Binds.join(" | "));
console.log("  restart       :", JSON.stringify(payload.HostConfig.RestartPolicy));
console.log("  proxy         :", proxyUrl ? proxyUrl.replace(/:\/\/[^@]*@/, "://***@") : "(none — drop-proxy)");
console.log("  no_proxy      :", noProxyList);
console.log("  env (masked)  :", maskEnv(payload.Env).join(", "));
for (const [n, ip] of Object.entries(ips)) {
  const asked = payload.NetworkingConfig.EndpointsConfig[n]?.IPAMConfig?.IPv4Address;
  console.log(`  ip ${n.padEnd(26)}: ${ip || "-"}${asked ? ` → يطلب نفس العنوان (${asked})` : " → قد يُسند من جديد"}`);
}

if (DRY) {
  console.log("\n=== CREATE PAYLOAD (dry-run) ===");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\n(dry-run: nothing changed)");
  process.exit(0);
}

// ---------------------------------------------------- pre-flight safety net
if (old.State?.Status !== "running") {
  console.error("✗ target container is not running (state=" + old.State?.Status + ") — refusing to recreate.");
  process.exit(1);
}
const pre = await health(old, payload, oldPass, 20_000);
if (!pre.ok) {
  console.error("✗ target container is NOT healthy right now (" + pre.last + ") — fix it before recreating.");
  process.exit(1);
}
console.log("  pre-flight: healthy ✓ via " + pre.base + " (baseURL=" + pre.baseURL + ")");

// guard: never run from inside the container we are about to replace
const myHost = os.hostname();
if (myHost && myHost.slice(0, 12) === oldId.slice(0, 12)) {
  console.error("✗ refusing to run inside the target container (it would die mid-flight).");
  console.error("  Run it from the host, or from a helper container with /var/run/docker.sock mounted.");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const backupName = `${TARGET}-pre-proxy-${stamp}`;

console.log("\n=== EXECUTE ===");
await api("POST", `/containers/${oldId}/stop?t=30`);
console.log("  1/5 stopped old container");
await api("POST", `/containers/${oldId}/rename?name=${backupName}`);
console.log("  2/5 renamed old →", backupName);

let created = null;
try {
  created = await api("POST", `/containers/create?name=${TARGET}`, payload);
  console.log("  3/5 created new container", created.Id.slice(0, 12));
} catch (e) {
  if (e.status === 400 && KEEP_IP) {
    console.log("  ! create failed with requested IP, retrying with dynamic IP");
    for (const n of Object.keys(payload.NetworkingConfig.EndpointsConfig)) {
      const ep = payload.NetworkingConfig.EndpointsConfig[n];
      if (ep.IPAMConfig) delete ep.IPAMConfig;
    }
    created = await api("POST", `/containers/create?name=${TARGET}`, payload);
    console.log("  3/5 created new container", created.Id.slice(0, 12));
  } else {
    console.error("  ✗ create failed:", e.message, JSON.stringify(e.body || {}).slice(0, 300));
    await api("POST", `/containers/${oldId}/rename?name=${TARGET}`).catch(() => {});
    await api("POST", `/containers/${TARGET}/start`).catch(() => {});
    console.error("  ↩ old container restored and started");
    process.exit(1);
  }
}

await api("POST", `/containers/${TARGET}/start`);
console.log("  4/5 started new container");

const info = await api("GET", `/containers/${TARGET}/json`);
const h = await health(info, payload, oldPass);
console.log("  5/5 health:", h.ok ? `✓ 200 via ${h.base} (baseURL=${h.baseURL})` : `✗ ${h.last}`);
if (!h.ok) {
  console.error("  ↩ rolling back");
  await api("POST", `/containers/${TARGET}/stop?t=15`).catch(() => {});
  await api("DELETE", `/containers/${TARGET}?force=1`).catch(() => {});
  await api("POST", `/containers/${oldId}/rename?name=${TARGET}`).catch(() => {});
  await api("POST", `/containers/${TARGET}/start`).catch(() => {});
  console.error("  ↩ original container restored and started");
  process.exit(1);
}

const newIps = {};
for (const n of Object.keys(info.NetworkSettings?.Networks || {})) newIps[n] = info.NetworkSettings.Networks[n]?.IPAddress;
console.log("\n=== DONE ===");
console.log("  new container id :", info.Id.slice(0, 12));
for (const [n, ip] of Object.entries(newIps)) {
  const changed = ips[n] && ip !== ips[n];
  console.log(`  ip ${n.padEnd(26)}: ${ip}${changed ? ` (was ${ips[n]} — حدّث أي مرجع إليه)` : " (unchanged)"}`);
}
console.log("  backup kept      :", backupName, "(stopped)");
console.log("  rollback command : node recreate-opencode-with-proxy.mjs --rollback");

if (SMOKE) {
  const base = h.base || candidates(info, payload)[0];
  const s = await smokeTest(base, oldPass, SMOKE);
  console.log("\n=== SMOKE (" + SMOKE + ") ===");
  console.log(" ", JSON.stringify(s));
}
