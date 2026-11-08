// Pool management for the OpenCode residential proxy pool.
// Pure logic: no HTTP server, no file access beyond an injected store.
import { testProxy } from "./proxy-tunnel.mjs";

export const DEFAULT_CHECK_HOST = "api.ipify.org";
export const DEFAULT_CHECK_PORT = 443;
export const DEFAULT_CHECK_PATH = "/?format=json";
export const DEFAULT_CONCURRENCY = 20;
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Run a full-pool health check.
 * @param {string[]} list proxy URLs
 * @param {object} opts
 * @param {(url:string)=>Promise<any>} [opts.check] override the per-proxy probe
 * @param {number} [opts.concurrency]
 * @param {number} [opts.timeout]
 * @param {(p:{done:number,total:number,ok:number,failed:number})=>void} [opts.onProgress]
 * @returns {Promise<{total:number,ok:string[],failed:{url:string,error:string}[],results:object[]}>}
 */
export async function checkPool(list, opts = {}) {
  const {
    check = (url) => testProxy(url, {
      host: opts.host || DEFAULT_CHECK_HOST,
      port: opts.port || DEFAULT_CHECK_PORT,
      path: opts.path || DEFAULT_CHECK_PATH,
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
    }),
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = null,
  } = opts;

  const total = list.length;
  const ok = [];
  const failed = [];
  const results = [];
  let done = 0;

  const report = () => {
    if (!onProgress) return;
    onProgress({
      done, total,
      ok: ok.length,
      failed: failed.length,
      okList: ok.slice(),
      failedList: failed.slice(),
    });
  };

  const worker = async () => {
    for (;;) {
      const idx = results.length;
      if (idx >= total) return;
      // Claim a slot by pushing a placeholder before awaiting.
      results.push(null);
      const url = list[idx];
      let r;
      try {
        r = await check(url);
      } catch (e) {
        r = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 160) };
      }
      const entry = { url, ok: !!r.ok, ip: r.ip || "", error: r.error || "", ms: r.ms || 0 };
      results[idx] = entry;
      if (entry.ok) ok.push(url);
      else failed.push({ url, error: entry.error || "failed" });
      done++;
      report();
    }
  };

  const n = Math.max(1, Math.min(concurrency, total || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { total, ok, failed, results: results.filter(Boolean) };
}

/**
 * Remove failed proxies from a list. Never removes the last remaining proxy
 * unless `allowEmpty` is set — an empty pool cannot serve any traffic.
 */
export function pruneFailed(list, failedUrls, { allowEmpty = false } = {}) {
  const kill = new Set(failedUrls.map((u) => String(u)));
  const kept = list.filter((u) => !kill.has(String(u)));
  if (kept.length === 0 && !allowEmpty) {
    return { list, removed: 0, skipped: "refused: would leave the pool empty" };
  }
  return { list: kept, removed: list.length - kept.length, skipped: null };
}
