#!/usr/bin/env node
// تشخيص: شغّله على الجهاز الذي يعمل فيه opencode بنجاح.
// node diag-personal.mjs [اسم نموذج يعمل عندك]
// يطبع: الإصدار · الحساب · عدد النماذج · نتيجة 3 طلبات مطابقة لما نفعله على الـVPS
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const WORKING_MODEL = process.argv[2] || "big-pickle";
const HOME = os.homedir();
const DATA = path.join(HOME, ".local/share/opencode");

function mask(s) {
  if (!s) return "(none)";
  return s.slice(0, 14) + "…" + ` (${s.length} chars)`;
}

function readToken() {
  // 1) new credential store (node:sqlite)
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(DATA, "opencode.db"), { readOnly: true });
    const row = db.prepare("SELECT value FROM credential WHERE integration_id='opencode'").get();
    if (row) {
      const v = JSON.parse(row.value);
      if (v.access) return { token: v.access, source: "opencode.db credential", meta: v.metadata };
      if (v.key) return { token: v.key, source: "opencode.db credential(key)", meta: v.metadata };
    }
  } catch (e) { /* fall through */ }
  // 2) legacy auth.json
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, "auth.json"), "utf8"));
    const oc = j.opencode;
    if (oc) {
      if (typeof oc === "string") return { token: oc, source: "auth.json", meta: null };
      if (oc.access) return { token: oc.access, source: "auth.json(access)", meta: oc };
      if (oc.key) return { token: oc.key, source: "auth.json(key)", meta: oc };
    }
  } catch (e) { /* fall through */ }
  return { token: null, source: "(none found)", meta: null };
}

console.log("=== 1) نسخة opencode على هذا الجهاز ===");
try { console.log("  " + execSync("opencode --version 2>/dev/null || echo '(opencode CLI غير موجود)'", { encoding: "utf8" }).trim()); } catch { console.log("  (تعذّر)"); }
console.log("  platform:", process.platform, "| arch:", process.arch);

console.log("\n=== 2) الاعتماد المحلي ===");
const { token, source, meta } = readToken();
console.log("  source:", source);
console.log("  token :", mask(token));
if (meta) console.log("  meta  :", JSON.stringify(meta).slice(0, 200));
if (!token) {
  console.log("\n  لا يوجد token محفوظ ⇒ شغّل: opencode auth login opencode  (أو اربط الحساب من /connect)");
  process.exit(0);
}

const H = {
  "content-type": "application/json",
  authorization: "Bearer " + token,
  "user-agent": "opencode/latest/probe/cli",
  "x-opencode-client": "cli",
};

console.log("\n=== 3) الحساب upstream ===");
for (const p of ["/console/api/user", "/inference/v1/models"]) {
  try {
    const res = await fetch("https://opencode.ai" + p, { headers: { ...H, accept: "application/json" } });
    const t = await res.text();
    let info = t.slice(0, 140);
    try { const j = JSON.parse(t); info = p.includes("models") ? (j.data?.length + " models") : JSON.stringify(j); } catch {}
    console.log("  " + p.padEnd(22) + " -> " + res.status + "  " + info.replace(/\s+/g, " ").slice(0, 140));
  } catch (e) { console.log("  " + p + " ERR " + e.message.slice(0, 50)); }
}

console.log("\n=== 4) نفس طلبات الـVPS (نفس النقطة، نفس النموذج) ===");
async function ask(label, url, model) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST", headers: H,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "say OK" }], max_tokens: 8 }),
    });
    const body = await res.text();
    let type = "-", msg = "";
    try { const j = JSON.parse(body); type = j?.error?.type ?? "-"; msg = String(j?.choices?.[0]?.message?.content ?? j?.error?.message ?? "").replace(/\s+/g, " ").slice(0, 80); } catch { msg = body.slice(0, 80); }
    const ra = res.headers.get("retry-after");
    console.log("  " + label.padEnd(44) + String(res.status).padEnd(4) + " " + String(type).padEnd(20) + " ra=" + String(ra ?? "-").padEnd(7) + " " + msg);
    if (res.status === 200) {
      console.log("      >>> WORKS HERE <<<  headers: " + JSON.stringify(Object.fromEntries([...res.headers].filter(([k]) => /limit|quota|allowance|opencode/i.test(k)))).slice(0, 300));
    }
    console.log("      (" + (Date.now() - t0) + "ms, " + new Date().toISOString() + ")");
  } catch (e) { console.log("  " + label.padEnd(44) + "ERR " + e.message.slice(0, 60)); }
}
await ask("inference/openai/v1  flint-40b-free", "https://opencode.ai/inference/openai/v1/chat/completions", "flint-40b-free");
await ask("zen/v1               flint-40b-free", "https://opencode.ai/zen/v1/chat/completions", "flint-40b-free");
await ask("inference/openai/v1  " + WORKING_MODEL, "https://opencode.ai/inference/openai/v1/chat/completions", WORKING_MODEL);
await ask("zen/v1               " + WORKING_MODEL, "https://opencode.ai/zen/v1/chat/completions", WORKING_MODEL);
console.log("\n=== انتهى ===");
