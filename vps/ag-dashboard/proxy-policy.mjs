// Routing policy for the opencode.ai proxy path.
//
// Everything here was measured on the live service:
//
// 1. The free models run on a SHARED anonymous pool: an unauthenticated
//    request (Bearer public) is answered with 429 FreeUsageLimitError from
//    every exit IP, with the same retry-after (the daily reset at 00:00 UTC).
//    Switching proxies therefore cannot help - the request has to fail fast
//    and the retry-after has to reach the client.
//
// 2. "This model is not available in your country" (403 RegionError) IS bound
//    to the exit IP: the same model works from a US exit and fails from a
//    French one. That proxy is quarantined and another one is tried.
//
// 3. A request that carries a personal API key must never travel through an
//    anonymous public proxy: only the trusted (residential) proxies may see
//    the key.

// The shared-pool limit. It shows up as a 429 with this error type.
const FREE_LIMIT_RE = /FreeUsageLimitError|free usage limit reached/i;
// The geo gate. It is bound to the exit IP.
const COUNTRY_RE = /not available in your country/i;

/**
 * Decide what to do with one upstream answer.
 *
 * @returns {{kind: "ok"|"fail-fast"|"poison", quarantine: boolean,
 *            reason: string|null, retryAfter: boolean}}
 */
export function classifyUpstream(status, body) {
  const text = typeof body === "string" ? body : "";
  if (COUNTRY_RE.test(text)) {
    return { kind: "poison", quarantine: true, reason: "country-blocked", retryAfter: false };
  }
  if (FREE_LIMIT_RE.test(text)) {
    // Shared pool: every exit IP is equally spent, so there is nothing to
    // switch to. Answer the client right away and keep the retry-after.
    return { kind: "fail-fast", quarantine: false, reason: "FreeUsageLimitError", retryAfter: true };
  }
  return { kind: "ok", quarantine: false, reason: null, retryAfter: false };
}

/**
 * Is this request carrying a personal credential?
 * The anonymous shared pool is marked with the literal token "public".
 */
export function isPersonalKeyRequest(headers) {
  const raw = headers && (headers.authorization || headers.Authorization);
  if (!raw) return false;
  const value = String(raw).trim();
  if (!value) return false;
  const m = /^Bearer\s+(.+)$/i.exec(value);
  if (!m) return true; // any other scheme (Basic, api-key, ...) is a credential
  const token = m[1].trim();
  if (!token) return false;
  return token.toLowerCase() !== "public";
}

/**
 * Pick the proxies a request may use.
 * A personal request is restricted to the trusted hosts so the key cannot
 * leak into an anonymous public proxy.
 *
 * A trusted entry is either a hostname ("dc.decodo.com") or a host:port pair
 * ("dc.decodo.com:10001"). The pair form narrows the set further.
 */
export function selectProxiesForRequest(proxies, { personal = false, trustedHosts = [] } = {}) {
  const list = Array.isArray(proxies) ? proxies : [];
  if (!personal) return list.slice();
  const hosts = new Set();
  const pairs = new Set();
  for (const raw of trustedHosts) {
    const entry = String(raw).toLowerCase();
    const idx = entry.lastIndexOf(":");
    if (idx > 0 && /^\d+$/.test(entry.slice(idx + 1))) {
      hosts.add(entry.slice(0, idx));
      pairs.add(entry);
    } else {
      hosts.add(entry);
    }
  }
  const portFilter = pairs.size > 0;
  return list.filter((p) => {
    let u;
    try { u = new URL(p); } catch { return false; }
    const host = u.hostname.toLowerCase();
    if (!hosts.has(host)) return false;
    if (portFilter) {
      const key = host + ":" + (u.port || "");
      if (!pairs.has(key)) return false;
    }
    return true;
  });
}
