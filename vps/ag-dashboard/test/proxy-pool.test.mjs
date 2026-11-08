import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPool, pruneFailed } from "../proxy-pool.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("checkPool: splits proxies into ok and failed lists", async () => {
  const list = ["http://a", "http://b", "http://c"];
  const res = await checkPool(list, {
    check: async (url) => url === "http://b" ? { ok: false, error: "boom" } : { ok: true, ip: "1.1.1.1", ms: 10 },
  });
  assert.equal(res.total, 3);
  assert.deepEqual(res.ok, ["http://a", "http://c"]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].url, "http://b");
  assert.equal(res.failed[0].error, "boom");
});

test("checkPool: reports progress for every checked proxy", async () => {
  const seen = [];
  await checkPool(["a", "b", "c", "d"], {
    check: async () => { await sleep(5); return { ok: true, ip: "1.1.1.1" }; },
    onProgress: (p) => seen.push(p.done),
  });
  assert.deepEqual(seen.sort((x, y) => x - y), [1, 2, 3, 4]);
});

test("checkPool: progress carries live ok/failed counters", async () => {
  const snaps = [];
  await checkPool(["a", "b", "c"], {
    check: async (url) => {
      await sleep(10);
      return url === "b" ? { ok: false, error: "no" } : { ok: true, ip: "1.1.1.1" };
    },
    onProgress: (p) => snaps.push({ ok: p.ok, failed: p.failed, okList: p.okList.length, failedList: p.failedList.length }),
  });
  const last = snaps[snaps.length - 1];
  assert.equal(last.ok, 2, "expected 2 ok at the end");
  assert.equal(last.failed, 1, "expected 1 failure at the end");
  assert.equal(last.okList, 2);
  assert.equal(last.failedList, 1);
  // Counters must be non-zero before the run finishes.
  assert.ok(snaps.some((s) => s.ok > 0 && s.failed > 0), "counters must be live mid-run");
});

test("checkPool: honours the concurrency limit", async () => {
  let active = 0, peak = 0;
  await checkPool(Array.from({ length: 12 }, (_, i) => "p" + i), {
    concurrency: 3,
    check: async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; return { ok: true }; },
  });
  assert.ok(peak <= 3, "peak concurrency was " + peak);
});

test("checkPool: a throwing probe is treated as a failure, not a crash", async () => {
  const res = await checkPool(["http://x"], {
    check: async () => { throw new Error("exploded"); },
  });
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /exploded/);
});

test("pruneFailed: removes only the failing proxies", () => {
  const list = ["a", "b", "c"];
  const out = pruneFailed(list, ["b"]);
  assert.deepEqual(out.list, ["a", "c"]);
  assert.equal(out.removed, 1);
});

test("pruneFailed: refuses to empty the pool", () => {
  const out = pruneFailed(["a"], ["a"]);
  assert.deepEqual(out.list, ["a"]);
  assert.equal(out.removed, 0);
  assert.match(out.skipped, /empty/);
});

test("pruneFailed: allows emptying when explicitly permitted", () => {
  const out = pruneFailed(["a"], ["a"], { allowEmpty: true });
  assert.deepEqual(out.list, []);
  assert.equal(out.removed, 1);
});
