// Policy tests for the opencode.ai proxy path.
//
// The behaviour that is being locked down here was measured on the live
// service, not guessed:
//   - 429 FreeUsageLimitError comes from the SHARED anonymous pool (every
//     exit IP answers 429 with the same retry-after), so switching proxies
//     cannot help: the request must fail fast and keep the retry-after.
//   - 403 "not available in your country" IS bound to the exit IP, so that
//     proxy is quarantined and another one is tried.
//   - A request that carries a personal API key must never travel through an
//     anonymous public proxy: only the Decodo (residential) entries are
//     allowed to see the key.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUpstream,
  isPersonalKeyRequest,
  selectProxiesForRequest,
} from "../proxy-policy.mjs";

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

// --- classification ---------------------------------------------------------

test("classifyUpstream: a 429 free usage limit fails fast instead of poisoning the proxy", () => {
  const verdict = classifyUpstream(429, FREE_LIMIT_BODY);
  assert.equal(verdict.kind, "fail-fast");
  assert.equal(verdict.quarantine, false, "a shared-pool limit must not park the exit IP");
  assert.equal(verdict.retryAfter, true, "the retry-after has to reach the client");
});

test("classifyUpstream: a country block poisons the exit IP", () => {
  const verdict = classifyUpstream(403, COUNTRY_BODY);
  assert.equal(verdict.kind, "poison");
  assert.equal(verdict.quarantine, true);
  assert.equal(verdict.reason, "country-blocked");
});

test("classifyUpstream: a healthy answer is passed through untouched", () => {
  const verdict = classifyUpstream(200, '{"choices":[{"message":{"content":"hi"}}]}');
  assert.equal(verdict.kind, "ok");
  assert.equal(verdict.quarantine, false);
});

test("classifyUpstream: an ordinary 429 without the free-limit body is not a shared-pool limit", () => {
  const verdict = classifyUpstream(429, '{"error":{"message":"Too many requests"}}');
  assert.equal(verdict.kind, "ok");
});

test("classifyUpstream: the free-limit body is detected whatever the status code", () => {
  assert.equal(classifyUpstream(403, FREE_LIMIT_BODY).kind, "fail-fast");
});

// --- personal key routing ---------------------------------------------------

test("isPersonalKeyRequest: a request with a real bearer token is personal", () => {
  assert.equal(isPersonalKeyRequest({ authorization: "Bearer sk-personal-123" }), true);
});

test("isPersonalKeyRequest: the anonymous shared pool is not personal", () => {
  assert.equal(isPersonalKeyRequest({ authorization: "Bearer public" }), false);
});

test("isPersonalKeyRequest: a request without an authorization header is not personal", () => {
  assert.equal(isPersonalKeyRequest({}), false);
});

test("isPersonalKeyRequest: the check ignores the case of the anonymous marker", () => {
  assert.equal(isPersonalKeyRequest({ authorization: "bearer PUBLIC" }), false);
});

test("selectProxiesForRequest: an anonymous request may use every proxy", () => {
  const pool = ["http://anon:8080", "http://sp08:pass@dc.decodo.com:10001"];
  const chosen = selectProxiesForRequest(pool, { personal: false, trustedHosts: ["dc.decodo.com"] });
  assert.equal(chosen.length, 2);
});

test("selectProxiesForRequest: a personal request only sees the trusted proxies", () => {
  const pool = ["http://anon:8080", "http://sp08:pass@dc.decodo.com:10001", "http://sp08:pass@dc.decodo.com:10002"];
  const chosen = selectProxiesForRequest(pool, { personal: true, trustedHosts: ["dc.decodo.com"] });
  assert.equal(chosen.length, 2);
  assert.ok(chosen.every((p) => /decodo/.test(p)), "only the trusted proxies may be chosen");
});

test("selectProxiesForRequest: a personal request with no trusted proxy gets an empty list", () => {
  const pool = ["http://anon:8080", "socks5://95.31.48.157:60000"];
  const chosen = selectProxiesForRequest(pool, { personal: true, trustedHosts: ["dc.decodo.com"] });
  assert.deepEqual(chosen, []);
});

test("selectProxiesForRequest: the trusted host list is matched on the hostname only", () => {
  const pool = ["http://user:pass@dc.decodo.com:10001", "http://user:pass@evil-dc.decodo.com.attacker.net:80"];
  const chosen = selectProxiesForRequest(pool, { personal: true, trustedHosts: ["dc.decodo.com"] });
  assert.equal(chosen.length, 1);
  assert.match(chosen[0], /dc\.decodo\.com:10001/);
});
