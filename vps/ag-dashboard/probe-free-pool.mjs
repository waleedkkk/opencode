#!/usr/bin/env node
// Probe the OpenCode free pool (shared, daily reset at 00:00 UTC).
// - "via"   : through the dashboard proxy path (Decodo / US exit)
// - "direct": straight from this host (France exit)
// Usage: node probe-free-pool.mjs <burst|watch> [ticks] [intervalSec]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const OUT = "/root/.local/share/opencode/free-pool-probe.jsonl";
const DASH = "http://127.0.0.1:8899/opencode-proxy/v1";
const DIRECT = "https://opencode.ai/inference/openai/v1";
const mode = process.argv[2] || "watch";
const ticks = Number(process.argv[3] || 24);
const intervalSec = Number(process.argv[4] || 300);

function personalToken() {
  try {
    const db = new DatabaseSync("/root/.local/share/opencode/opencode.db", { readOnly: true });
    const row = db.prepare("SELECT value FROM credential WHERE integration_id='opencode'").get();
    if (!row) return null;
    const v = JSON.parse(row.value);
    if (v.access && v.expires > Date.now()) return v.access;
    return null;
  } catch {
    return null;
  }
}

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(OUT, line + "\n");
  console.log(line);
}

async function ask(base, model, token) {
  const t0 = Date.now();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  try {
    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "say OK" }],
        max_tokens: 4,
      }),
    });
    const body = await res.text();
    let type = "-";
    let msg = "";
    try {
      const j = JSON.parse(body);
      type = j?.error?.type ?? "-";
      msg = String(j?.choices?.[0]?.message?.content ?? j?.error?.message ?? "").slice(0, 60);
    } catch {
      msg = body.slice(0, 60);
    }
    return {
      status: res.status,
      type,
      msg,
      ra: res.headers.get("retry-after"),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { status: "ERR", type: "-", msg: String(e.message).slice(0, 60), ra: null, ms: Date.now() - t0 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tick(i, burst) {
  const tok = personalToken();
  const stamp = new Date().toISOString();

  // 1) via Decodo (US) - what the opencode server will experience
  const usFlint = await ask(DASH, "flint-40b-free", tok);
  log({ phase: mode, tick: i, route: "us-proxy", model: "flint-40b-free", ...usFlint });

  // 2) via Decodo (US) - the region-gated pair
  const usCrouton = await ask(DASH, "crouton-alpha-free", tok);
  log({ phase: mode, tick: i, route: "us-proxy", model: "crouton-alpha-free", ...usCrouton });

  // 3) direct (FR) - the France path
  const frFlint = await ask(DIRECT, "flint-40b-free", tok);
  log({ phase: mode, tick: i, route: "direct-fr", model: "flint-40b-free", ...frFlint });

  // 4) anonymous (public) for comparison
  const anonFlint = await ask(DIRECT, "flint-40b-free", "public");
  log({ phase: mode, tick: i, route: "direct-fr", model: "flint-40b-free", auth: "public", ...anonFlint });

  // 5) burst: how fast does the shared pool drain?
  if (burst) {
    for (let k = 0; k < burst; k++) {
      const r = await ask(DASH, "flint-40b-free", tok);
      log({ phase: mode + "-burst", tick: i, n: k + 1, route: "us-proxy", model: "flint-40b-free", ...r });
      if (r.status !== 200) break; // the pool is spent; no point hammering it
      await sleep(1200);
    }
  }
  return { usFlint, usCrouton, frFlint, anonFlint, stamp };
}

const waitMs = Math.max(0, new Date("2026-11-06T00:00:05Z").getTime() - Date.now());
if (waitMs > 0) {
  log({ phase: "wait", until: new Date(Date.now() + waitMs).toISOString(), waitSec: Math.round(waitMs / 1000) });
  await sleep(waitMs);
}

if (mode === "burst") {
  await tick(1, Number(process.argv[5] || 5));
} else {
  for (let i = 1; i <= ticks; i++) {
    await tick(i, i === 1 ? 5 : 0);
    if (i < ticks) await sleep(intervalSec * 1000);
  }
}
log({ phase: "done" });
