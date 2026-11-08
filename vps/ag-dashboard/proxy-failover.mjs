// Proxy failover helpers.
//
// opencode.ai answers a request from the exit IP of the proxy that carried
// it. One upstream error therefore means "this exit IP is not usable":
//   - not available in your country (the IP is geo-blocked)
// Such a proxy is quarantined for a while instead of being deleted, so the
// pool keeps its entries and can recover on its own.
//
// The other upstream error - FreeUsageLimitError - is NOT handled here: it
// comes from the shared anonymous pool, so it applies to every exit IP at
// once and switching proxies cannot help. See proxy-policy.mjs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_QUARANTINE_TTL_MS = 60 * 60 * 1000; // one hour

/**
 * A file-backed quarantine store. The state lives next to the proxy pool so
 * it survives a server restart.
 */
export function createQuarantineStore(filePath) {
  const read = () => {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      const proxies = raw && typeof raw === "object" && raw.proxies && typeof raw.proxies === "object"
        ? raw.proxies
        : {};
      return proxies;
    } catch {
      return {};
    }
  };

  const write = (proxies) => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ version: 1, proxies }, null, 2));
    } catch {
      /* a broken quarantine file must never break the proxy path */
    }
  };

  // Entries whose deadline has passed are dropped from every view.
  const purge = (proxies, now) => {
    const out = {};
    for (const [url, entry] of Object.entries(proxies)) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.until === "number" && entry.until <= now) continue;
      out[url] = entry;
    }
    return out;
  };

  return {
    /** Every live entry, oldest deadline first. */
    list(now = Date.now()) {
      return Object.entries(purge(read(), now))
        .map(([url, entry]) => ({ url, ...entry }))
        .sort((a, b) => (a.until || 0) - (b.until || 0));
    },

    /** Is this proxy currently quarantined? */
    has(url, now = Date.now()) {
      return Object.prototype.hasOwnProperty.call(purge(read(), now), url);
    },

    /** How many proxies are quarantined right now. */
    size(now = Date.now()) {
      return Object.keys(purge(read(), now)).length;
    },

    /** Quarantine a proxy for `ttlMs`; repeated failures count the hits. */
    add(url, reason, { ttlMs = DEFAULT_QUARANTINE_TTL_MS, now = Date.now() } = {}) {
      const proxies = purge(read(), now);
      const prev = proxies[url];
      const entry = {
        reason: reason || "unknown",
        until: now + ttlMs,
        at: now,
        hits: (prev && typeof prev.hits === "number" ? prev.hits : 0) + 1,
      };
      proxies[url] = entry;
      write(proxies);
      return entry;
    },

    /** Release one proxy, or all of them when no url is given. */
    clear(url) {
      const proxies = read();
      if (url === undefined || url === null) {
        write({});
        return Object.keys(proxies).length;
      }
      const existed = Object.prototype.hasOwnProperty.call(proxies, url);
      delete proxies[url];
      write(proxies);
      return existed ? 1 : 0;
    },
  };
}
