// =============================================================================
// oc-container-proxy.test.mjs
// The dashboard must control the proxy that actually works for the opencode
// provider: a CONNECT tunnel (HTTPS_PROXY) in the opencode-server container's
// environment.
//
// Measured 2026-11-08:
//   - the opencode provider refuses the HTTP-level proxy of the dashboard:
//     Node terminates the TLS -> opencode.ai answers 429 FreeUsageLimitError,
//     while the Bun client (opencode itself) gets 200 on the same request.
//   - the CONNECT tunnel keeps the client's own TLS -> the request leaves from
//     a US residential IP -> the geo-blocked models (crouton-alpha-free)
//     answer normally.
//
// So the panel button must read the REAL state (the container env) and drive
// the recreate script, not rewrite a dead "options.baseURL" in the config.
// =============================================================================
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { pathToFileURL } from "node:url"

const MODULE_PATH = "/workspace/ag-dashboard/oc-container-proxy.mjs"
const DASHBOARD_PATH = "/workspace/ag-dashboard/server.mjs"
const SCRIPT_PATH = "/workspace/ag-dashboard/recreate-opencode-with-proxy.mjs"

async function loadModule() {
  return await import(pathToFileURL(MODULE_PATH).href + "?t=" + Date.now())
}

test("the container proxy module exists", () => {
  assert.ok(fs.existsSync(MODULE_PATH), `module must exist at ${MODULE_PATH}`)
})

test("parseProxyEnv reads the proxy out of the container environment", async () => {
  const mod = await loadModule()
  const parsed = mod.parseProxyEnv([
    "OPENCODE_SERVER_PASSWORD=secret",
    "HTTPS_PROXY=http://user:pass@dc.decodo.com:10001",
    "HTTP_PROXY=http://user:pass@dc.decodo.com:10001",
    "NO_PROXY=localhost,127.0.0.1",
  ])
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.proxyUrl, "http://user:pass@dc.decodo.com:10001")
  assert.equal(parsed.host, "dc.decodo.com")
})

test("parseProxyEnv reports no proxy when the environment has none", async () => {
  const mod = await loadModule()
  const parsed = mod.parseProxyEnv(["PATH=/usr/bin", "NO_PROXY=localhost"])
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.proxyUrl, "")
})

test("maskProxyUrl hides the credentials but keeps the host", async () => {
  const mod = await loadModule()
  const masked = mod.maskProxyUrl("http://sample-user:secret-pass@dc.decodo.com:10001")
  assert.ok(!masked.includes("secret-pass"), `the password must not leak: ${masked}`)
  assert.ok(masked.includes("dc.decodo.com"), `the host must stay visible: ${masked}`)
})

test("buildHelperArgs enables the tunnel with keep-ip and a smoke test", async () => {
  const mod = await loadModule()
  const args = mod.buildHelperArgs({
    enabled: true,
    proxyUrl: "http://u:p@dc.decodo.com:10001",
    smoke: "opencode/crouton-alpha-free",
  })
  assert.ok(args.includes("--keep-ip"), args.join(" "))
  assert.ok(args.includes("--no-proxy") === false, args.join(" "))
  assert.ok(args.includes("--proxy"), args.join(" "))
  assert.ok(args.includes("http://u:p@dc.decodo.com:10001"), args.join(" "))
  assert.ok(args.includes("--smoke"), args.join(" "))
  assert.ok(args.includes("opencode/crouton-alpha-free"), args.join(" "))
})

test("buildHelperArgs disables the tunnel with --drop-proxy", async () => {
  const mod = await loadModule()
  const args = mod.buildHelperArgs({ enabled: false })
  assert.ok(args.includes("--drop-proxy"), args.join(" "))
  assert.ok(!args.includes("--proxy"), args.join(" "))
})

test("buildHelperArgs builds a rollback invocation", async () => {
  const mod = await loadModule()
  assert.deepEqual(mod.buildHelperArgs({ rollback: true }), ["--rollback"])
})

test("the recreate script can remove the proxy from the container", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8")
  assert.match(source, /drop-proxy/, "the script must support removing HTTPS_PROXY")
})

test("the dashboard reads the container state through the new module", () => {
  const source = fs.readFileSync(DASHBOARD_PATH, "utf8")
  assert.match(source, /oc-container-proxy\.mjs/, "the dashboard must import the new module")
  assert.match(source, /\/api\/proxies\/oc-proxy/, "the dashboard must expose the new endpoint")
})

test("the dashboard no longer decides the state by grepping the config file", () => {
  const source = fs.readFileSync(DASHBOARD_PATH, "utf8")
  const fn = source.match(/function isOcProxyEnabled\(\)\s*\{[\s\S]{0,400}?\n\}/)?.[0] || ""
  assert.ok(fn, "isOcProxyEnabled must still exist")
  assert.ok(
    !/includes\("opencode-proxy\/v1"\)/.test(fn),
    "the state must not be a string grep of the config file (it was a false green)",
  )
})
