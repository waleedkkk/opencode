// =============================================================================
// antigravity-identity.test.mjs
// Tests for the Antigravity plugin client identity (UA version + metadata
// platform) and for detecting Google's "no longer supported" notice inside a
// 200 SSE body.
//
// Background (measured 2026-11-07):
//   - Google gates the Antigravity tier by the client version carried in the
//     User-Agent. Versions < 2.0.0 get HTTP 200 whose SSE body carries the
//     deprecation notice instead of a model answer.
//   - The server-side proto also changed: ClientMetadata.Platform no longer
//     accepts "MACOS" (400 INVALID_ARGUMENT); only PLATFORM_UNSPECIFIED is
//     accepted by loadCodeAssist today.
// =============================================================================
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const PLUGIN_PATH = process.env.ANTIGRAVITY_PLUGIN || "/root/.config/opencode/plugins/antigravity/index.js"
const source = fs.readFileSync(PLUGIN_PATH, "utf8")

// --- helpers mirroring the plugin's own parsing ----------------------------
function constantOf(name) {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]{0,600}?)\\nconst\\s+[A-Z_]+\\s*=`))
  if (!m) return null
  return m[1].trim()
}
function stringConst(name) {
  // the plugin stores JSON metadata in a single-quoted string, so prefer that
  // form before the double-quoted one (double quotes may appear inside)
  const single = source.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`))
  if (single) return single[1]
  const dbl = source.match(new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"`))
  return dbl ? dbl[1] : null
}

// The effective identity comes from the shared module (file-backed), so the
// assertions below run against what the plugin actually sends.
async function effectiveIdentity() {
  const mod = await import(
    pathToFileURL(process.env.ANTIGRAVITY_IDENTITY_MODULE || "/root/.config/opencode/antigravity-identity.mjs").href +
      "?t=" +
      Date.now()
  )
  return mod.loadIdentity()
}

test("the effective client identity declares a supported Antigravity version (>= 2.0.0)", async () => {
  const identity = await effectiveIdentity()
  const version = identity.userAgent.match(/Antigravity\/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(version, `identity has no Antigravity/<major>.<minor>.<patch> token: ${identity.userAgent}`)
  const major = Number(version[1])
  assert.ok(
    major >= 2,
    `Antigravity client version ${version[0]} is rejected by Google (>= 2.0.0 required); ` +
      `the server answers 200 with the "no longer supported" notice instead of a model reply`,
  )
})

test("the effective client metadata uses a platform value the current server proto accepts", async () => {
  const identity = await effectiveIdentity()
  assert.equal(
    identity.clientMetadata.platform,
    "PLATFORM_UNSPECIFIED",
    `metadata.platform=${identity.clientMetadata.platform} is rejected by the current server proto (400 INVALID_ARGUMENT)`,
  )
})

test("plugin exposes a deprecation-notice detector", () => {
  assert.match(
    source,
    /no longer supported/,
    "plugin must detect Google's deprecation notice inside the response body",
  )
  assert.match(
    source,
    /export\s+(async\s+)?function\s+(\w*[Dd]eprecat\w*|\w*Notice\w*)/,
    "plugin must export a helper that recognizes the deprecation notice",
  )
})

// --- live behaviour of the exported detector --------------------------------
test("detector flags the deprecation notice and ignores normal model text", async () => {
  const mod = await import(pathToFileURL(PLUGIN_PATH).href + "?t=" + Date.now())
  const detect = mod.detectDeprecationNotice || mod.detectDeprecation
  assert.equal(typeof detect, "function", "plugin must export detectDeprecationNotice(text)")

  assert.equal(
    detect(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"This version of Antigravity is no longer supported. Please download and install the latest version"}]}}]}}',
    ),
    true,
  )
  assert.equal(detect('data: {"response":{"candidates":[{"content":{"parts":[{"text":"PONG"}]}}]}}'), false)
  assert.equal(detect(""), false)
  assert.equal(detect(undefined), false)
})

// --- the SSE guard used by the http.response hook ---------------------------
const NOTICE_SSE =
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"This version of Antigravity is no longer supported. Please download and install the latest version at https://antigravity.google/download"}]}}]}}\n\n'
const OK_SSE =
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"PONG"}]}}]}}\n\n'

test("guard flags a 200 SSE body that only carries the deprecation notice", async () => {
  const mod = await import(pathToFileURL(PLUGIN_PATH).href + "?t=" + Date.now())
  assert.equal(typeof mod.inspectSseBody, "function", "plugin must export inspectSseBody(body)")
  const result = await mod.inspectSseBody(new Response(NOTICE_SSE).body)
  assert.equal(result.notice, true)
})

test("guard replays the consumed head so a normal SSE body survives intact", async () => {
  const mod = await import(pathToFileURL(PLUGIN_PATH).href + "?t=" + Date.now())
  const result = await mod.inspectSseBody(new Response(OK_SSE).body)
  assert.equal(result.notice, false)
  assert.ok(result.body, "guard must return a readable stream")
  const text = await new Response(result.body).text()
  assert.equal(text, OK_SSE, "the SSE body must be replayed byte-for-byte (no lost head)")
})

test("guard never hangs on a notice body (cancel must not await a tee branch)", async () => {
  const mod = await import(pathToFileURL(PLUGIN_PATH).href + "?t=" + Date.now())
  const done = await Promise.race([
    mod.inspectSseBody(new Response(NOTICE_SSE).body).then(() => "resolved"),
    new Promise((r) => setTimeout(() => r("timed-out"), 3000)),
  ])
  assert.equal(done, "resolved", "inspectSseBody must resolve (not hang) on a notice body")
})
