import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuarantineStore } from "../proxy-failover.mjs";

const FREE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeUsageLimitError",
    message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
  },
});

const COUNTRY_BODY = JSON.stringify({
  error: { message: "This model is not available in your country", type: "invalid_request_error" },
});

// --- quarantine store ------------------------------------------------------

function tmpFile(name = "quarantine.json") {
  const dir = mkdtempSync(join(tmpdir(), "quar-"));
  return join(dir, name);
}

test("quarantine store: an added proxy is reported as quarantined", () => {
  const store = createQuarantineStore(tmpFile());
  store.add("http://p1:8080", "FreeUsageLimitError", { ttlMs: 60000 });
  assert.equal(store.has("http://p1:8080"), true);
  assert.equal(store.size(), 1);
});

test("quarantine store: an unknown proxy is not quarantined", () => {
  const store = createQuarantineStore(tmpFile());
  assert.equal(store.has("http://other:8080"), false);
  assert.equal(store.size(), 0);
});

test("quarantine store: the entry records the reason and the expiry", () => {
  const store = createQuarantineStore(tmpFile());
  const now = 1_000_000;
  store.add("http://p1:8080", "country", { ttlMs: 60000, now });
  const entry = store.list(now)[0];
  assert.equal(entry.url, "http://p1:8080");
  assert.equal(entry.reason, "country");
  assert.equal(entry.until, now + 60000);
  assert.equal(entry.hits, 1);
});

test("quarantine store: an expired entry is released automatically", () => {
  const store = createQuarantineStore(tmpFile());
  const now = 1_000_000;
  store.add("http://p1:8080", "country", { ttlMs: 1000, now });
  assert.equal(store.has("http://p1:8080", now + 2000), false, "expired entry must not block");
  assert.equal(store.size(), 0, "expired entries are purged");
});

test("quarantine store: clear removes one proxy", () => {
  const store = createQuarantineStore(tmpFile());
  store.add("http://p1:8080", "r", { ttlMs: 60000 });
  store.add("http://p2:8080", "r", { ttlMs: 60000 });
  store.clear("http://p1:8080");
  assert.equal(store.has("http://p1:8080"), false);
  assert.equal(store.has("http://p2:8080"), true);
});

test("quarantine store: clear without an argument removes everything", () => {
  const store = createQuarantineStore(tmpFile());
  store.add("http://p1:8080", "r", { ttlMs: 60000 });
  store.add("http://p2:8080", "r", { ttlMs: 60000 });
  store.clear();
  assert.equal(store.size(), 0);
});

test("quarantine store: the state survives a restart (new store, same file)", () => {
  const file = tmpFile();
  createQuarantineStore(file).add("http://p1:8080", "country", { ttlMs: 600000 });
  const reopened = createQuarantineStore(file);
  assert.equal(reopened.has("http://p1:8080"), true);
});

test("quarantine store: a repeated failure counts the hits", () => {
  const store = createQuarantineStore(tmpFile());
  store.add("http://p1:8080", "r", { ttlMs: 60000 });
  store.add("http://p1:8080", "r", { ttlMs: 60000 });
  assert.equal(store.list()[0].hits, 2);
});

test("quarantine store: a corrupt file is treated as empty", () => {
  const file = tmpFile();
  writeFileSync(file, "{not json");
  const store = createQuarantineStore(file);
  assert.equal(store.size(), 0);
  assert.equal(store.has("http://p1:8080"), false);
});

test("quarantine store: the file on disk holds the quarantined urls", () => {
  const file = tmpFile();
  createQuarantineStore(file).add("http://p1:8080", "country", { ttlMs: 60000 });
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(raw.proxies["http://p1:8080"], "the url must be persisted");
  assert.equal(raw.proxies["http://p1:8080"].reason, "country");
});
