// =============================================================================
// antigravity-identity-config.test.mjs
// The Antigravity client identity (User-Agent / api-client / metadata) must be
// configurable through a JSON file so a new client version can be rolled out
// without editing code.
//
// Background (measured 2026-11-07): Google gates the Antigravity tier on the
// client version in the User-Agent. Versions < 2.0.0 get HTTP 200 whose SSE
// body carries the deprecation notice instead of a model answer.
// =============================================================================
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const MODULE_PATH = process.env.ANTIGRAVITY_IDENTITY_MODULE || "/root/.config/opencode/antigravity-identity.mjs"
const IDENTITY_FILE = process.env.ANTIGRAVITY_IDENTITY_FILE || "/root/.config/opencode/antigravity-identity.json"
const PLUGIN_PATH = "/root/.config/opencode/plugins/antigravity/index.js"
const DASHBOARD_PATH = "/workspace/ag-dashboard/server.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ag-identity-"))
}
function writeJson(file, data) {
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n")
}
async function loadModule() {
  return await import(pathToFileURL(MODULE_PATH).href + "?t=" + Date.now())
}

test("identity module exists", () => {
  assert.ok(fs.existsSync(MODULE_PATH), `identity module must exist at ${MODULE_PATH}`)
})

test("defaults carry a supported Antigravity version (>= 2.0.0)", async () => {
  const mod = await loadModule()
  assert.ok(mod.DEFAULT_IDENTITY, "module must export DEFAULT_IDENTITY")
  const version = mod.DEFAULT_IDENTITY.userAgent.match(/Antigravity\/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(version, `default userAgent has no version token: ${mod.DEFAULT_IDENTITY.userAgent}`)
  assert.ok(Number(version[1]) >= 2, `default Antigravity version ${version[0]} is rejected by Google`)
  assert.equal(mod.DEFAULT_IDENTITY.clientMetadata.platform, "PLATFORM_UNSPECIFIED")
})

test("the identity file supplies the userAgent", async () => {
  const mod = await loadModule()
  const dir = tmpDir()
  const file = path.join(dir, "identity.json")
  writeJson(file, {
    userAgent: "Mozilla/5.0 Antigravity/2.44.0 Chrome/140",
    apiClient: "google-cloud-sdk vscode/1.99.0",
    clientMetadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
  })
  const identity = mod.loadIdentity({ file })
  assert.equal(identity.userAgent, "Mozilla/5.0 Antigravity/2.44.0 Chrome/140")
  assert.equal(identity.apiClient, "google-cloud-sdk vscode/1.99.0")
  assert.equal(identity.source, "file")
  assert.deepEqual(identity.warnings, [])
})

test("a missing identity file falls back to the built-in defaults", async () => {
  const mod = await loadModule()
  const identity = mod.loadIdentity({ file: path.join(tmpDir(), "absent.json") })
  assert.equal(identity.source, "default")
  assert.equal(identity.userAgent, mod.DEFAULT_IDENTITY.userAgent)
  assert.equal(identity.clientMetadata.platform, "PLATFORM_UNSPECIFIED")
  assert.ok(identity.warnings.length > 0, "fallback must be reported as a warning")
})

test("a corrupt identity file falls back to the built-in defaults", async () => {
  const mod = await loadModule()
  const file = path.join(tmpDir(), "identity.json")
  writeJson(file, "{ this is not json")
  const identity = mod.loadIdentity({ file })
  assert.equal(identity.source, "default")
  assert.equal(identity.userAgent, mod.DEFAULT_IDENTITY.userAgent)
  assert.ok(identity.warnings.length > 0, "corrupt file must be reported as a warning")
})

test("malformed fields fall back individually, valid fields are kept", async () => {
  const mod = await loadModule()
  const file = path.join(tmpDir(), "identity.json")
  writeJson(file, { userAgent: 123, apiClient: "keep-me", clientMetadata: { platform: "PLATFORM_UNSPECIFIED" } })
  const identity = mod.loadIdentity({ file })
  assert.equal(identity.userAgent, mod.DEFAULT_IDENTITY.userAgent, "non-string userAgent must fall back")
  assert.equal(identity.apiClient, "keep-me", "valid apiClient must be kept")
  assert.equal(identity.clientMetadata.ideType, "ANTIGRAVITY", "missing metadata fields must fall back")
  assert.ok(identity.warnings.length > 0)
})

test("an outdated Antigravity version is reported as a warning", async () => {
  const mod = await loadModule()
  const file = path.join(tmpDir(), "identity.json")
  writeJson(file, { userAgent: "Mozilla/5.0 Antigravity/1.18.3 Chrome/138" })
  const identity = mod.loadIdentity({ file })
  assert.equal(identity.source, "file", "the file value is still used")
  assert.ok(
    identity.warnings.some((w) => /1\.18\.3/.test(w) && /2\.0\.0/.test(w)),
    `an outdated version must warn: ${JSON.stringify(identity.warnings)}`,
  )
})

test("a supported version produces no version warning", async () => {
  const mod = await loadModule()
  const file = path.join(tmpDir(), "identity.json")
  writeJson(file, { userAgent: "Mozilla/5.0 Antigravity/2.29.0 Chrome/138" })
  const identity = mod.loadIdentity({ file })
  assert.ok(!identity.warnings.some((w) => /2\.0\.0/.test(w)), `unexpected warning: ${JSON.stringify(identity.warnings)}`)
})

test("changing the identity file is picked up without a restart", async () => {
  const mod = await loadModule()
  const file = path.join(tmpDir(), "identity.json")
  writeJson(file, { userAgent: "Mozilla/5.0 Antigravity/2.29.0 Chrome/138" })
  const first = mod.loadIdentity({ file })
  assert.equal(first.userAgent, "Mozilla/5.0 Antigravity/2.29.0 Chrome/138")

  writeJson(file, { userAgent: "Mozilla/5.0 Antigravity/2.50.0 Chrome/141" })
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  const second = mod.loadIdentity({ file })
  assert.equal(second.userAgent, "Mozilla/5.0 Antigravity/2.50.0 Chrome/141", "a changed file must be re-read")
})

test("identityHeaders maps the identity to the three Google headers", async () => {
  const mod = await loadModule()
  const identity = mod.loadIdentity({ file: path.join(tmpDir(), "absent.json") })
  const headers = mod.identityHeaders(identity)
  assert.equal(headers["User-Agent"], identity.userAgent)
  assert.equal(headers["X-Goog-Api-Client"], identity.apiClient)
  assert.deepEqual(JSON.parse(headers["Client-Metadata"]), identity.clientMetadata)
})

test("the warning watcher reports a warning only once, but reports new warnings later", async () => {
  const mod = await loadModule()
  const file = path.join(tmpDir(), "identity.json")
  writeJson(file, { userAgent: "Mozilla/5.0 Antigravity/2.29.0 Chrome/138" })
  const watch = mod.createIdentityWatcher()

  const clean = mod.loadIdentity({ file })
  assert.deepEqual(watch(clean), [], "a healthy identity has nothing to report")

  writeJson(file, { userAgent: "Mozilla/5.0 Antigravity/1.18.3 Chrome/138" })
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  const stale = mod.loadIdentity({ file })
  const first = watch(stale)
  assert.equal(first.length, 1, "the outdated-version warning must be reported")
  assert.match(first[0], /1\.18\.3/)

  assert.deepEqual(watch(stale), [], "the same warning must not be reported twice")
})

// --- the shipped production identity ---------------------------------------
test("the shipped identity file exists and carries a supported version", () => {
  assert.ok(fs.existsSync(IDENTITY_FILE), `identity file must exist at ${IDENTITY_FILE}`)
  const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"))
  const version = data.userAgent.match(/Antigravity\/(\d+)\./)
  assert.ok(version, `identity file has no Antigravity version token: ${data.userAgent}`)
  assert.ok(Number(version[1]) >= 2, `shipped Antigravity version ${version[0]} is rejected by Google`)
})

// --- consumers must not hardcode the identity anymore ------------------------
test("the plugin reads its identity from the shared module", () => {
  const source = fs.readFileSync(PLUGIN_PATH, "utf8")
  assert.match(source, /antigravity-identity\.mjs/, "plugin must import the shared identity module")
  assert.ok(!/Antigravity\/1\.18\.3/.test(source), "plugin must not hardcode the outdated version")
})

test("the dashboard reads its identity from the shared module", () => {
  const source = fs.readFileSync(DASHBOARD_PATH, "utf8")
  assert.match(source, /antigravity-identity\.mjs/, "dashboard must import the shared identity module")
  assert.ok(!/Antigravity\/1\.18\.3/.test(source), "dashboard must not hardcode the outdated version")
})
