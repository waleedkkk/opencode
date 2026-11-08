// =============================================================================
// antigravity-identity.mjs
// Shared source of truth for the Antigravity client identity.
//
// Google gates the Antigravity tier on the client identity. Measured
// 2026-11-07: a User-Agent carrying Antigravity/1.x receives HTTP 200 whose
// SSE body is the "This version of Antigravity is no longer supported"
// notice instead of a model answer; Antigravity/2.x receives a real reply.
// The server proto also stopped accepting metadata.platform = "MACOS"
// (400 INVALID_ARGUMENT) — PLATFORM_UNSPECIFIED is accepted today.
//
// Putting the identity in a JSON file means a new client version can be
// rolled out by editing one file, with no code change and no restart.
// =============================================================================
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const IDENTITY_FILE =
  process.env.ANTIGRAVITY_IDENTITY_FILE || path.join(os.homedir(), ".config", "opencode", "antigravity-identity.json")

// Built-in fallback: the values proven to work on 2026-11-07.
export const DEFAULT_IDENTITY = Object.freeze({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Antigravity/2.29.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
  apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
  clientMetadata: Object.freeze({
    ideType: "ANTIGRAVITY",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  }),
})

// Google currently rejects any Antigravity client below this major version.
export const MIN_SUPPORTED_MAJOR = 2

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function majorVersion(userAgent) {
  const match = String(userAgent || "").match(/Antigravity\/(\d+)\./)
  return match ? Number(match[1]) : undefined
}

/**
 * Loads the client identity.
 *
 * @param {{file?: string, force?: boolean}} [options]
 * @returns {{userAgent: string, apiClient: string, clientMetadata: object,
 *            source: "file"|"default", warnings: string[]}}
 */
export function loadIdentity(options = {}) {
  const file = options.file || IDENTITY_FILE
  const warnings = []
  let source = "default"
  let raw

  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
    source = "file"
  } catch (error) {
    warnings.push(
      `تعذّر قراءة ملف الهوية ${file} (${error.message}) — تم استخدام القيم الافتراضية المدمجة`,
    )
    raw = undefined
  }

  const identity = {
    userAgent: DEFAULT_IDENTITY.userAgent,
    apiClient: DEFAULT_IDENTITY.apiClient,
    clientMetadata: { ...DEFAULT_IDENTITY.clientMetadata },
    source,
    warnings,
  }

  if (raw !== undefined) {
    if (!isPlainObject(raw)) {
      warnings.push(`ملف الهوية ${file} ليس كائن JSON صالح — تم استخدام القيم الافتراضية`)
      identity.source = "default"
    } else {
      if (typeof raw.userAgent === "string" && raw.userAgent.trim()) {
        identity.userAgent = raw.userAgent.trim()
      } else if (raw.userAgent !== undefined) {
        warnings.push(`userAgent في ${file} ليس نصاً — تم استخدام القيمة الافتراضية`)
      }
      if (typeof raw.apiClient === "string" && raw.apiClient.trim()) {
        identity.apiClient = raw.apiClient.trim()
      } else if (raw.apiClient !== undefined) {
        warnings.push(`apiClient في ${file} ليس نصاً — تم استخدام القيمة الافتراضية`)
      }
      if (isPlainObject(raw.clientMetadata)) {
        for (const key of ["ideType", "platform", "pluginType"]) {
          const value = raw.clientMetadata[key]
          if (typeof value === "string" && value.trim()) identity.clientMetadata[key] = value.trim()
        }
      } else if (raw.clientMetadata !== undefined) {
        warnings.push(`clientMetadata في ${file} ليس كائناً — تم استخدام القيم الافتراضية`)
      }
    }
  }

  const major = majorVersion(identity.userAgent)
  if (major !== undefined && major < MIN_SUPPORTED_MAJOR) {
    warnings.push(
      `نسخة عميل Antigravity ${identity.userAgent.match(/Antigravity\/[\d.]+/)?.[0]} قديمة — ` +
        `Google سيردّ بنص "This version of Antigravity is no longer supported" ` +
        `(المطلوب ${MIN_SUPPORTED_MAJOR}.0.0 أو أحدث)`,
    )
  }

  return identity
}

/**
 * Creates a watcher that reports each distinct warning only once.
 *
 * The identity is re-read on every request, so the same warning would
 * otherwise be emitted forever. New warnings (e.g. the file was edited to an
 * outdated version) are still reported as soon as they appear.
 */
export function createIdentityWatcher() {
  const seen = new Set()
  return function watch(identity) {
    const fresh = []
    for (const warning of identity?.warnings || []) {
      if (seen.has(warning)) continue
      seen.add(warning)
      fresh.push(warning)
    }
    return fresh
  }
}

/**
 * Maps a loaded identity to the three headers Google expects.
 */
export function identityHeaders(identity) {
  return {
    "User-Agent": identity.userAgent,
    "X-Goog-Api-Client": identity.apiClient,
    "Client-Metadata": JSON.stringify(identity.clientMetadata),
  }
}
