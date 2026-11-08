// =============================================================================
// oc-container-proxy.mjs
// The dashboard's control for the proxy that actually works with the opencode
// provider.
//
// Measured 2026-11-08 (see PLAN-ACCOUNT-LINK.md):
//   - opencode.ai answers 429 FreeUsageLimitError to the dashboard's
//     HTTP-level proxy: Node terminates the TLS and opencode.ai tells the
//     transport apart. The Bun client (opencode itself) gets 200.
//   - a CONNECT tunnel (HTTPS_PROXY in the container environment) keeps the
//     client's own TLS, so the request leaves from the residential exit IP
//     and the geo-blocked models (crouton-alpha-free) answer normally.
//
// So the panel reads the real state (the container env) and drives the
// recreate script. Docker's POST /containers/<id>/update ignores Env, so
// changing it needs a recreate — the script keeps a backup and can roll back.
// =============================================================================
import http from "node:http"
import fs from "node:fs"

const SOCK = process.env.AG_DOCKER_SOCK || "/var/run/docker.sock"
const TARGET = process.env.AG_TARGET_CONTAINER || "opencode-server"
const HELPER_NAME = "ag-proxy-recreate"
const HELPER_IMAGE = process.env.AG_HELPER_IMAGE || "node:22-alpine"
const PROXIES_FILE = process.env.AG_PROXIES_FILE || "/root/.config/opencode/opencode_proxies.json"
const SCRIPT = "/workspace/ag-dashboard/recreate-opencode-with-proxy.mjs"
const LOG_FILE = "/workspace/ag-dashboard/recreate-proxy.log"

// ---------------------------------------------------------------- docker api
export function dockerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const headers = { "X-Api-Version": "1.44", "Content-Type": "application/json" }
    if (data) headers["content-length"] = Buffer.byteLength(data)
    const req = http.request({ socketPath: SOCK, path, method, headers }, (res) => {
      let raw = ""
      res.on("data", (c) => (raw += c))
      res.on("end", () => {
        let parsed
        try { parsed = raw ? JSON.parse(raw) : {} } catch { parsed = { raw } }
        if (res.statusCode >= 400) {
          reject(new Error(`docker ${method} ${path} -> ${res.statusCode}: ${String(parsed.message || raw).slice(0, 160)}`))
        } else resolve(parsed)
      })
    })
    req.on("error", reject)
    if (data) req.write(data)
    req.end()
  })
}

// ------------------------------------------------------------- pure helpers
export function maskProxyUrl(url) {
  if (!url) return ""
  const text = String(url)
  // keep the user, hide the password: http://user:***@host:port
  if (/:\/\/([^:@/]+):([^@/]+)@/.test(text)) return text.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@")
  if (/:\/\/[^@/]+@/.test(text)) return text.replace(/:\/\/[^@/]+@/, "://***@")
  return text
}

/** Reads the tunnel out of a container environment array. */
export function parseProxyEnv(env) {
  const list = Array.isArray(env) ? env : []
  const entry =
    list.find((e) => typeof e === "string" && e.startsWith("HTTPS_PROXY=")) ||
    list.find((e) => typeof e === "string" && e.startsWith("HTTP_PROXY="))
  const proxyUrl = entry ? String(entry.slice(entry.indexOf("=") + 1)).trim() : ""
  let host = ""
  try { host = proxyUrl ? new URL(proxyUrl).hostname : "" } catch {}
  return { enabled: !!proxyUrl, proxyUrl, host }
}

/** Arguments for recreate-opencode-with-proxy.mjs. */
export function buildHelperArgs({ enabled = true, proxyUrl = null, smoke = null, rollback = false } = {}) {
  if (rollback) return ["--rollback"]
  const args = ["--keep-ip"]
  if (enabled) {
    if (proxyUrl) args.push("--proxy", proxyUrl)
    if (smoke) args.push("--smoke", smoke)
  } else {
    args.push("--drop-proxy")
  }
  return args
}

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// ------------------------------------------------------------------- state
export function readLog(lines = 12) {
  try {
    const raw = fs.readFileSync(LOG_FILE, "utf8")
    return raw.trim().split("\n").slice(-lines).join("\n")
  } catch { return "" }
}

/** The real state: the proxy lives in the target container's environment. */
export async function readState() {
  try {
    const c = await dockerRequest("GET", `/containers/${TARGET}/json`)
    const parsed = parseProxyEnv(c.Config?.Env)
    return {
      ok: true,
      enabled: parsed.enabled,
      proxy: maskProxyUrl(parsed.proxyUrl),
      proxyHost: parsed.host,
      container: String(c.Name || "").replace(/^\//, ""),
      containerId: String(c.Id || "").slice(0, 12),
      status: c.State?.Status,
      startedAt: c.State?.StartedAt,
      restartCount: c.RestartCount ?? 0,
      networks: Object.entries(c.NetworkSettings?.Networks || {}).map(([name, v]) => ({ name, ip: v.IPAddress })),
      log: readLog(),
    }
  } catch (e) {
    return { ok: false, enabled: false, error: String(e?.message || e).slice(0, 200) }
  }
}

/** The first trusted (residential) proxy of the pool. */
export function pickPoolProxy() {
  try {
    const j = JSON.parse(fs.readFileSync(PROXIES_FILE, "utf8"))
    const list = (Array.isArray(j) ? j : j.proxies || [])
      .map((x) => (typeof x === "string" ? x : x?.url))
      .filter(Boolean)
    const trusted = list.filter((u) => /decodo\.com/i.test(u))
    return String(trusted[0] || list[0] || "").trim()
  } catch { return "" }
}

// ------------------------------------------------------------------ control
/**
 * Starts the helper container that performs the recreate.
 *
 * The helper lives outside the target container, so the dashboard can start it
 * and return immediately: the target container is replaced underneath us and
 * this process dies with it. The helper writes its log to LOG_FILE, which
 * survives (bind mount) and is shown after the restart.
 */
export async function startHelper(args) {
  await dockerRequest("DELETE", `/containers/${HELPER_NAME}?force=1`).catch(() => {})
  const cmd = `node ${SCRIPT} ${args.map(shellQuote).join(" ")} > ${LOG_FILE} 2>&1; echo "EXIT=$?" >> ${LOG_FILE}`
  const payload = {
    Image: HELPER_IMAGE,
    Cmd: ["sh", "-c", cmd],
    Env: ["HOME=/root", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    WorkingDir: "/workspace/ag-dashboard",
    HostConfig: {
      NetworkMode: "host",
      AutoRemove: false,
      Binds: [
        "/var/run/docker.sock:/var/run/docker.sock",
        "/root/opencode-docker/workspace:/workspace",
        "/root/opencode-docker/v2/config:/root/.config/opencode",
        "/root/opencode-docker/v2/data:/root/.local/share/opencode",
      ],
    },
  }
  const created = await dockerRequest("POST", `/containers/create?name=${HELPER_NAME}`, payload)
  await dockerRequest("POST", `/containers/${created.Id}/start`)
  return { ok: true, helperId: String(created.Id).slice(0, 12), args }
}

export async function enable({ smoke = "opencode/crouton-alpha-free" } = {}) {
  const proxyUrl = pickPoolProxy()
  if (!proxyUrl) return { ok: false, error: `no proxy found in ${PROXIES_FILE}` }
  const args = buildHelperArgs({ enabled: true, proxyUrl, smoke })
  return { ...(await startHelper(args)), proxy: maskProxyUrl(proxyUrl) }
}

export async function disable() {
  return await startHelper(buildHelperArgs({ enabled: false }))
}

export async function rollback() {
  return await startHelper(buildHelperArgs({ rollback: true }))
}
