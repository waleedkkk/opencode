#!/usr/bin/env node
/**
 * Link the OpenCode account to this OpenCode server.
 *
 * Two supported ways to attach a personal credential:
 *   1) device flow  : opencode auth login opencode --method device
 *                     (the CLI polls opencode.ai and writes the credential itself)
 *   2) Console key  : POST /api/integration/opencode/connect/key
 *                     (used here when the user pastes a Console API key)
 *
 * Usage:
 *   node apply-opencode-key.mjs              -> status only
 *   node apply-opencode-key.mjs <KEY>        -> attach the key, then verify
 *   node apply-opencode-key.mjs --verify     -> verify only
 *
 * The key never touches the proxy pool: the request goes straight to
 * 127.0.0.1:4096 (the local OpenCode server), which is what stores it in the
 * `credential` table. The provider then reads it from there.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.AG_SERVER_BASE || "http://127.0.0.1:4096";
const PASS_FILE = "/root/.local/share/opencode/opencode-web-pass";

function basicAuth() {
  let pass = "";
  try { pass = readFileSync(PASS_FILE, "utf8").trim(); } catch {}
  if (!pass) pass = process.env.OPENCODE_SERVER_PASSWORD || "";
  if (!pass) throw new Error("no opencode web password found");
  return "Basic " + Buffer.from("opencode:" + pass).toString("base64");
}

const HEADERS = { Authorization: basicAuth(), "Content-Type": "application/json" };

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function mask(key) {
  const s = String(key);
  return s.length <= 10 ? s.slice(0, 3) + "…" : s.slice(0, 6) + "…" + s.slice(-4);
}

async function status() {
  const creds = await api("/api/credential?directory=/");
  const list = creds.json?.data || [];
  const oc = list.filter((c) => c.integrationID === "opencode");
  const provider = await api("/api/provider/opencode?directory=/");
  const p = provider.json?.data || {};
  const hasAuth = !p.settings?.apiKey || p.settings.apiKey !== "public";

  console.log("credential rows for opencode : " + (oc.length ? oc.map((c) => `${c.label} (${c.value?.type || "?"})`).join(", ") : "none"));
  console.log("provider.settings.apiKey     : " + (p.settings?.apiKey === "public" ? "public  (anonymous shared pool)" : hasAuth ? "linked (personal credential in use)" : "not set"));
  console.log("provider.settings.baseURL    : " + (p.settings?.baseURL || "-"));
  return { oc, hasAuth, provider: p };
}

async function attach(key) {
  console.log("attaching key " + mask(key) + " ...");
  const res = await api("/api/integration/opencode/connect/key?directory=/", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
  console.log("POST /api/integration/opencode/connect/key -> " + res.status);
  if (res.status >= 400) {
    console.log("body: " + res.text.slice(0, 400));
    process.exitCode = 1;
    return;
  }
}

// A linked account is only proven by a real 200 from the inference API.
async function verifyUpstream() {
  const provider = await api("/api/provider/opencode?directory=/");
  const base = provider.json?.data?.settings?.baseURL || "https://opencode.ai/inference/openai/v1";
  const creds = await api("/api/credential?directory=/");
  const oc = (creds.json?.data || []).find((c) => c.integrationID === "opencode");
  const key = oc?.value?.key;
  const header = key ? "Bearer " + key : "Bearer public";

  const res = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: header },
    body: JSON.stringify({ model: "flint-40b-free", messages: [{ role: "user", content: "say OK" }] }),
  });
  const text = await res.text();
  let type = "-";
  try { type = JSON.parse(text)?.error?.type ?? "-"; } catch {}
  console.log("upstream probe (" + (key ? "personal key" : "public") + ") -> status=" + res.status + " type=" + type);
  if (res.status !== 200) console.log("  body: " + text.slice(0, 300));
  return res.status;
}

const arg = process.argv[2];
if (arg && arg !== "--verify") {
  await attach(arg);
}
await status();
if (arg === "--verify" || arg) await verifyUpstream();
