/**
 * Antigravity provider for OpenCode V2 — Phase 1 (vertical slice)
 *
 * What it does:
 *   1. Registers an "antigravity" provider cloned from the bundled google provider.
 *   2. Redirects its requests to the Cloud Code endpoint (v1internal).
 *   3. Injects an OAuth access token obtained from the account pool.
 *   4. Wraps the Gemini body in the Cloud Code envelope.
 *   5. Unwraps the `{ response: ... }` envelope from the SSE stream.
 *
 * Phase 1 scope (deliberate):
 *   - One account at a time (first healthy one). No rotation on 429 yet.
 *   - No thinking-signature cache, no Claude transforms, no quota UI.
 *
 * Written as a plain object (no `@opencode/plugin` import) so it loads
 * without extra dependencies — same approach superpowers 6.4.2 uses.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { loadIdentity, createIdentityWatcher } from "/root/.config/opencode/antigravity-identity.mjs"

/* ------------------------------------------------------------------ */
/* Constants (mirrored from opencode-ag-auth@1.6.3/src/constants.js)  */
/* ------------------------------------------------------------------ */

const PROVIDER_ID = "antigravity"
const CONFIG_DIR = "/root/.config/opencode"
const ACCOUNTS_FILE = path.join(CONFIG_DIR, "antigravity-accounts.json")
const LOG_FILE = path.join(CONFIG_DIR, "antigravity-v2.log")

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = (process.env.ANTIGRAVITY_CLIENT_SECRET || "")
const TOKEN_URL = "https://oauth2.googleapis.com/token"

const ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com"
const ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
const ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com"
// نفس ترتيب opencode-ag-auth V1: daily أولاً (هو المسار صاحب الكوتة اليومية)،
// ثم autopush ثم prod عند فشل الشبكة/404 فقط. ال429 يُعالَج بتدوير الحسابات.
const ENDPOINTS = [ENDPOINT_DAILY, ENDPOINT_AUTOPUSH, ENDPOINT_PROD]
let endpointIndex = 0
let endpointSwitchedAt = 0
const ENDPOINT = () => {
  // بعد 10 دقائق من التبديل، عُد إلى daily (المسار الأساسي المُجرَّب)
  if (endpointIndex !== 0 && endpointSwitchedAt && Date.now() - endpointSwitchedAt > 10 * 60_000) {
    endpointIndex = 0
    endpointSwitchedAt = 0
    log("عودة تلقائية إلى daily بعد مهلة 10 دقائق")
  }
  return ENDPOINTS[endpointIndex]
}
const DEFAULT_PROJECT = "rising-fact-p41fc"

// Antigravity client identity.
// - The server gates the Antigravity tier on the client version in the UA:
//   versions < 2.0.0 receive HTTP 200 whose body is the "no longer supported"
//   notice instead of a model answer (measured 2026-11-07: 1.18.3/1.19.0/
//   1.20.0/1.50.0/1.99.0 => notice, 2.0.0/2.29.0 => real reply).
//   Current official Antigravity App version: 2.29.0.
// - metadata.platform: the server proto no longer accepts "MACOS"
//   (400 INVALID_ARGUMENT on loadCodeAssist); PLATFORM_UNSPECIFIED is accepted.
//
// The values live in antigravity-identity.json (shared with the dashboard) so
// a new client version can be rolled out without editing code. The built-in
// defaults below are only a fallback when that file is missing or unreadable.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Antigravity/2.29.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36"
const DEFAULT_API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1"
const DEFAULT_CLIENT_METADATA = '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'

let identityCache = null
let identityCacheMtime = 0
const watchIdentityWarnings = createIdentityWatcher()

function currentIdentity() {
  const file = path.join(CONFIG_DIR, "antigravity-identity.json")
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {}
  if (identityCache && mtime === identityCacheMtime) return identityCache

  const identity = loadIdentity({ file })
  identityCache = identity
  identityCacheMtime = mtime
  for (const warning of watchIdentityWarnings(identity)) {
    log("هوية العميل: " + warning)
  }
  return identity
}

const USER_AGENT = () => currentIdentity().userAgent || DEFAULT_USER_AGENT
const API_CLIENT = () => currentIdentity().apiClient || DEFAULT_API_CLIENT
const CLIENT_METADATA = () =>
  JSON.stringify(currentIdentity().clientMetadata || JSON.parse(DEFAULT_CLIENT_METADATA))

/* ------------------------------------------------------------------ */
/* Logging                                                            */
/* ------------------------------------------------------------------ */

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  try {
    fs.appendFileSync(LOG_FILE, line + "\n")
  } catch {}
  console.log("[antigravity] " + message)
}

/* ------------------------------------------------------------------ */
/* Account pool                                                       */
/* ------------------------------------------------------------------ */

let accounts = []
let cursor = 0
let accountsMtime = 0
const tokenCache = new Map() // email -> { access, expires }
const blockedUntil = new Map() // email -> ts (429 marks, in-memory)
const retryRequests = new Map() // request-id -> retry state
let pendingAccount = undefined // legacy fallback for runtimes without event.request

function loadAccounts() {
  try {
    try { accountsMtime = fs.statSync(ACCOUNTS_FILE).mtimeMs } catch {}
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))
    const list = Array.isArray(raw.accounts) ? raw.accounts : []

    accounts = list
      .map((entry, index) => {
        const parts = String(entry.refreshToken ?? "").split("|")
        return {
          index,
          email: entry.email ?? `account-${index + 1}`,
          enabled: entry.enabled !== false,
          refreshToken: parts[0] || "",
          projectId: entry.projectId || parts[1] || parts[2] || "",
          rateLimits: entry.rateLimitResetTimes ?? {},
        }
      })
      .filter((account) => account.enabled && account.refreshToken)

    // نظّف كاش التوكنات والحظر لأي حساب تم حذفه
    const validEmails = new Set(accounts.map((a) => a.email))
    for (const email of tokenCache.keys()) {
      if (!validEmails.has(email)) tokenCache.delete(email)
    }
    for (const email of blockedUntil.keys()) {
      if (!validEmails.has(email)) blockedUntil.delete(email)
    }

    cursor = Number(raw.activeIndex ?? 0) || 0
    if (cursor >= accounts.length) cursor = 0
    log(`loaded ${accounts.length} enabled account(s); activeIndex=${cursor}`)
    return accounts
  } catch (error) {
    log(`could not load accounts: ${error.message}`)
    accounts = []
    return accounts
  }
}

function checkAccountsReload() {
  try {
    const mt = fs.statSync(ACCOUNTS_FILE).mtimeMs
    if (mt !== accountsMtime) loadAccounts()
  } catch {}
}

function pickAccount(excludeEmail = "") {
  checkAccountsReload()
  if (!accounts.length) loadAccounts()
  if (!accounts.length) return undefined

  const now = Date.now()
  for (let offset = 0; offset < accounts.length; offset++) {
    const idx = (cursor + offset) % accounts.length
    const account = accounts[idx]
    if (account.email === excludeEmail) continue
    if ((blockedUntil.get(account.email) || 0) > now) continue
    const resets = Object.values(account.rateLimits ?? {})
    const blocked = resets.some((value) => typeof value === "number" && value > now)
    if (!blocked) {
      cursor = idx
      return account
    }
  }
  // الجميع محجوب: اختر الأقرب إلى انتهاء حظره بدل التكرار على الأول.
  let best = accounts[0], bestUntil = Infinity
  for (const account of accounts) {
    const until = blockedUntil.get(account.email) || 0
    if (until < bestUntil) { bestUntil = until; best = account }
  }
  cursor = accounts.indexOf(best)
  return best
}

async function getAccessToken(account, force = false) {
  const cached = tokenCache.get(account.email)
  if (!force && cached && cached.expires > Date.now() + 60_000) return cached.access

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: account.refreshToken,
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`token refresh failed ${response.status}: ${text.slice(0, 300)}`)
  }

  const payload = JSON.parse(text)
  if (!payload.access_token) throw new Error("token refresh returned no access_token")

  const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600
  tokenCache.set(account.email, {
    access: payload.access_token,
    expires: Date.now() + expiresIn * 1000,
  })
  log(`refreshed token for ${account.email} (valid ${expiresIn}s)`)
  return payload.access_token
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Deprecation notice detection                                      */
/* ------------------------------------------------------------------ */

// Google may answer HTTP 200 with an SSE body that carries the deprecation
// notice instead of a model reply. Such a response looks "successful" to the
// transport but is not a model answer, so it must be surfaced as an error.
export function detectDeprecationNotice(text) {
  if (!text) return false
  return /no longer supported/i.test(String(text))
}

const DEPRECATION_NOTICE =
  "This version of Antigravity is no longer supported. Please download and install " +
  "the latest version at https://antigravity.google/download to continue using the agent."

// Reads the head of an SSE body and reports whether it carries Google's
// deprecation notice. The consumed head is re-emitted through the returned
// stream so the original payload is never lost.
//
// NOTE: this deliberately does NOT use response.clone() + reader.cancel():
// cancelling one branch of a tee only settles the composite promise once the
// other branch is also cancelled, which deadlocks the request.
export async function inspectSseBody(body, limit = 8192) {
  if (!body) return { notice: false, body: null }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const head = []
  let text = ""
  let done = false
  let notice = false

  try {
    while (text.length < limit) {
      const { value, done: finished } = await reader.read()
      if (finished) {
        done = true
        break
      }
      head.push(value)
      text += decoder.decode(value, { stream: true })
      if (detectDeprecationNotice(text)) {
        notice = true
        break
      }
    }
  } catch {
    done = true
  }

  if (notice) {
    // Stop the upstream body without awaiting a tee branch.
    reader.cancel().catch(() => {})
    return { notice: true, body: null }
  }

  const replay = new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk)
      if (done) {
        controller.close()
        return
      }
    },
    async pull(controller) {
      try {
        const { value, done: finished } = await reader.read()
        if (finished) {
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch {
        controller.close()
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {})
    },
  })

  return { notice: false, body: replay }
}

function rewriteSseLine(line) {
  if (!line.startsWith("data:")) return line
  const json = line.slice(5).trim()
  if (!json || json === "[DONE]") return line
  try {
    const parsed = JSON.parse(json)
    if (parsed && parsed.response !== undefined) {
      return "data: " + JSON.stringify(parsed.response)
    }
  } catch {}
  return line
}

function unwrapStream(body) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let index
        while ((index = buffer.indexOf("\n")) >= 0) {
          let line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line.endsWith("\r")) line = line.slice(0, -1)
          controller.enqueue(encoder.encode(rewriteSseLine(line) + "\n"))
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer)))
      },
    }),
  )
}

/* ------------------------------------------------------------------ */
/* Safe quota retry helpers                                           */
/* ------------------------------------------------------------------ */
function parseQuotaResetMs(text) {
  const m = String(text || "").match(/Resets in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i)
  if (!m) return 0
  const ms = ((Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) +
    (Number(m[3] || 0) * 60) + Number(m[4] || 0)) * 1000
  return ms > 0 ? Date.now() + ms : 0
}
function rememberQuota(account, model, until) {
  if (!account || !until) return
  account.rateLimits = account.rateLimits || {}
  account.rateLimits[model || "gemini"] = until
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))
    const item = (raw.accounts || []).find((x) => x.email === account.email)
    if (!item) return
    item.rateLimitResetTimes = item.rateLimitResetTimes || {}
    item.rateLimitResetTimes[model || "gemini"] = until
    const tmp = ACCOUNTS_FILE + ".tmp-" + process.pid
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, ACCOUNTS_FILE)
  } catch (e) { log(`quota state save skipped: ${e.message}`) }
}
/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

export default {
  id: "antigravity.provider",

  async setup(ctx) {
    loadAccounts()

    /* ---- 1. register the provider, cloned from the bundled google one ---- */
    let registered = false
    try {
      await ctx.provider.transform((editor) => {
        const google = editor.get("google")
        if (!google) {
          log("google provider not found — cannot clone; aborting registration")
          return
        }

        const info = structuredClone(google.provider)
        info.id = PROVIDER_ID
        info.name = "Antigravity"
        info.activation = "enabled"
        info.settings = {
          ...(info.settings ?? {}),
          baseURL: ENDPOINT(),
          apiKey: "antigravity-oauth",
        }

        const models = [...google.models.values()].map((model) => {
          const clone = structuredClone(model)
          clone.providerID = PROVIDER_ID
          return clone
        })

        editor.add({ info, models })
        registered = true
        log(`registered provider "${PROVIDER_ID}" with ${models.length} model(s)`)
      })
    } catch (error) {
      log(`provider transform failed: ${error.message}`)
    }

    if (!registered) log("provider transform queued (callback runs when the catalog is ready)")

    /* ---- 2. rewrite the outbound request ---- */
    await ctx.session.hook(
      "http.request",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return

        const account = pickAccount()
        if (!account) {
          log("no usable account — aborting request")
          return
        }
        pendingAccount = account

        let token
        try {
          token = await getAccessToken(account)
        } catch (error) {
          log(`token error: ${error.message}`)
          return
        }

        const url = new URL(event.request.url)
        const match = url.pathname.match(/\/models\/([^:/]+)(?::([A-Za-z]+))?$/)
        const modelID = match ? decodeURIComponent(match[1]) : ""
        const action = match?.[2] || "streamGenerateContent"
        const streaming = action === "streamGenerateContent"

        // daily لا يعرّف gemini-3.8-flash بالاسم المجرد (404) — الصيغة -tiered هي المتاحة
        const MODEL_ALIASES = { "gemini-3.8-flash": "gemini-3.8-flash-tiered" }

        const headers = new Headers(event.request.headers)
        for (const name of [
          "x-api-key",
          "x-goog-api-key",
          "x-goog-user-project",
          "authorization",
          "content-length",
          "accept-encoding",
        ]) {
          headers.delete(name)
        }
        headers.set("authorization", `Bearer ${token}`)
        headers.set("user-agent", USER_AGENT())
        headers.set("x-goog-api-client", API_CLIENT())
        headers.set("client-metadata", CLIENT_METADATA())
        headers.set("content-type", "application/json")
        if (streaming) headers.set("accept", "text/event-stream")

        let body
        try {
          body = JSON.parse(await event.request.text())
        } catch {
          log("request body was not JSON — leaving request untouched")
          return
        }

        const alreadyWrapped = typeof body.project === "string" && body.request !== undefined
        const wrapped = alreadyWrapped
          ? body
          : {
              project: account.projectId || DEFAULT_PROJECT,
              model: modelID,
              requestId: "agent-" + crypto.randomUUID(),
              request: body,
            }
        wrapped.project = wrapped.project || account.projectId || DEFAULT_PROJECT
        wrapped.model = MODEL_ALIASES[modelID] || wrapped.model || modelID

        const target = `${ENDPOINT()}/v1internal:${action}${streaming ? "?alt=sse" : ""}`
        const retryId = crypto.randomUUID()
        headers.set("x-antigravity-request-id", retryId)
        const wrappedText = JSON.stringify(wrapped)
        event.request = new Request(target, {
          method: "POST",
          headers,
          body: wrappedText,
        })
        retryRequests.set(retryId, {
          account,
          model: wrapped.model || modelID,
          action,
          target,
          headers: new Headers(headers),
          body: wrappedText,
          attempts: 0,
          createdAt: Date.now(),
        })
        log(`-> ${action} model=${wrapped.model} project=${wrapped.project} account=${account.email} kind=${event.kind}`)
      },
      { providerID: PROVIDER_ID },
    )

    /* ---- 3. unwrap the response ---- */
    await ctx.session.hook(
      "http.response",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return

        let contentType = (event.response.headers.get("content-type") || "").toLowerCase()
        const headers = new Headers(event.response.headers)
        const retryId = event.request?.headers?.get?.("x-antigravity-request-id") || ""
        const retryState = retryRequests.get(retryId)
        headers.delete("content-length")
        headers.delete("content-encoding")

        log(`<-${event.response.status} ${contentType || "-"}`)

        // فشل مسار بنيتي (5xx فقط): جرّب المسار التالي. ال404 يعني نموذجاً
        // غير متاح على هذا المسار — تبديل المسار لن يفيد وقد يضر.
        if (event.response.status >= 500) {
          const current = ENDPOINTS[endpointIndex]
          const next = ENDPOINTS[(endpointIndex + 1) % ENDPOINTS.length]
          if (next !== current) {
            endpointIndex = (endpointIndex + 1) % ENDPOINTS.length
            endpointSwitchedAt = Date.now()
            log(`مسار ${new URL(current).host} فشل (${event.response.status}) — التبديل إلى ${new URL(next).host}`)
          }
        }

        if (event.response.status === 429) {
          const account = retryState?.account || pendingAccount || accounts[cursor]
          let quotaText = ""
          try { quotaText = await event.response.clone().text() } catch {}
          const modelKey = retryState?.model || "gemini"
          const resetAt = parseQuotaResetMs(quotaText)
          const window = resetAt ? Math.max(resetAt - Date.now(), 60_000) : 5 * 60_000
          if (account) {
            blockedUntil.set(account.email, Date.now() + window)
            if (resetAt) rememberQuota(account, modelKey, resetAt)
            log(`429 على ${account.email} للنموذج ${modelKey} — حظر ${Math.ceil(window / 60000)}د`)
          }
          while (retryState && retryState.attempts < 3 && event.request && event.response.status === 429) {
            retryState.attempts += 1
            const next = pickAccount(account?.email || "")
            if (!next || next.email === account?.email) {
              log("لا يوجد حساب بديل متاح لإعادة المحاولة")
              break
            }
            try {
              const token = await getAccessToken(next)
              const h = new Headers(retryState.headers)
              h.set("authorization", `Bearer ${token}`)
              h.set("x-antigravity-request-id", retryId)
              const retryResponse = await fetch(retryState.target, {
                method: "POST", headers: h, body: retryState.body,
              })
              log(`إعادة محاولة ${retryState.attempts}/3 للنموذج ${modelKey} عبر ${next.email} — HTTP ${retryResponse.status}`)
              retryState.account = next
              event.response = retryResponse
              contentType = (retryResponse.headers.get("content-type") || "").toLowerCase()
              headers.delete("content-length")
              headers.delete("content-encoding")
              if (retryResponse.status === 429) {
                const second = await retryResponse.clone().text().catch(() => "")
                const secondReset = parseQuotaResetMs(second)
                const secondWindow = secondReset ? Math.max(secondReset - Date.now(), 60_000) : 5 * 60_000
                blockedUntil.set(next.email, Date.now() + secondWindow)
                if (secondReset) rememberQuota(next, modelKey, secondReset)
                continue
              }
              break
            } catch (e) {
              log(`retry failed: ${e.message}`)
              break
            }
          }
          if (retryState && retryState.attempts >= 3) retryRequests.delete(retryId)
        }

        if (event.response.status !== 429 && retryId) retryRequests.delete(retryId)
        if (event.response.status >= 400) {
          try {
            const probe = event.response.clone()
            const head = await probe.text()
            log(`<-${event.response.status} body: ` + head.slice(0, 300).replace(/\s+/g, " "))
          } catch {}
        }

        if (event.response.status === 401 || event.response.status === 403) {
          const account = accounts[cursor]
          if (account) tokenCache.delete(account.email)
          log(`auth rejected (${event.response.status}) — token cache cleared`)
        }

        if (contentType.includes("text/event-stream") && event.response.body) {
          // Google can answer 200 with the deprecation notice *inside* the SSE
          // body. Peek at the head to catch it, otherwise it looks like a
          // successful (but empty) model answer.
          const inspected = await inspectSseBody(event.response.body)

          if (inspected.notice) {
            log(`<-${event.response.status} نص إهمال Antigravity داخل SSE — تحويله إلى خطأ واضح`)
            event.response = new Response(
              JSON.stringify({
                error: {
                  code: 400,
                  message:
                    "Antigravity client identity is outdated: " + DEPRECATION_NOTICE +
                    " (the plugin's User-Agent version must be >= 2.0.0)",
                  status: "INVALID_ARGUMENT",
                },
              }),
              { status: 400, statusText: "Bad Request", headers },
            )
            return
          }

          event.response = new Response(unwrapStream(inspected.body), {
            status: event.response.status,
            statusText: event.response.statusText,
            headers,
          })
          return
        }

        const text = await event.response.text()
        let output = text
        if (detectDeprecationNotice(text)) {
          log(`<-${event.response.status} نص إهمال Antigravity داخل الرد — تحويله إلى خطأ واضح`)
          event.response = new Response(
            JSON.stringify({
              error: {
                code: 400,
                message:
                  "Antigravity client identity is outdated: " + DEPRECATION_NOTICE +
                  " (the plugin's User-Agent version must be >= 2.0.0)",
                status: "INVALID_ARGUMENT",
              },
            }),
            { status: 400, statusText: "Bad Request", headers },
          )
          return
        }
        try {
          const parsed = JSON.parse(text)
          if (parsed && parsed.response !== undefined) output = JSON.stringify(parsed.response)
          else if (parsed && parsed.error) log(`upstream error: ${JSON.stringify(parsed.error).slice(0, 300)}`)
        } catch {}

        event.response = new Response(output, {
          status: event.response.status,
          statusText: event.response.statusText,
          headers,
        })
      },
      { providerID: PROVIDER_ID },
    )

    log("phase 1 hooks registered")

    return () => {
      log("unloaded")
    }
  },
}
