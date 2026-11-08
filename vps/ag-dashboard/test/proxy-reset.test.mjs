import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { testProxy } from "../proxy-tunnel.mjs";

// A proxy that accepts the CONNECT then abruptly resets the connection.
// The raw TCP socket behind the TLS wrapper emits 'error' with no listener,
// which used to crash the whole dashboard process.
async function startResettingProxy() {
  const srv = createNetServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", () => {
      sock.resetAndDestroy ? sock.resetAndDestroy() : sock.destroy();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

test("testProxy: a reset connection does not crash the process", async (t) => {
  const proxy = await startResettingProxy();
  t.after(() => proxy.close());

  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.removeListener("uncaughtException", onUncaught));

  const res = await testProxy(`http://127.0.0.1:${proxy.port}`, {
    host: "api.ipify.org", port: 443, timeout: 4000,
  });

  assert.equal(res.ok, false, "must report failure");
  assert.ok(res.error, "must carry an error message");
  // Give any late socket error a chance to surface.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(errors.length, 0, "no uncaught exception: " + (errors[0] && errors[0].message));
});

test("testProxy: a socket error after the response is swallowed", async (t) => {
  const proxy = await startResettingProxy();
  t.after(() => proxy.close());
  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.removeListener("uncaughtException", onUncaught));

  await testProxy(`http://127.0.0.1:${proxy.port}`, { host: "api.ipify.org", port: 443, timeout: 3000 });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(errors.length, 0, "no uncaught exception: " + (errors[0] && errors[0].message));
});

// The TLS wrapper can emit its own error ("socket disconnected before secure
// TLS connection was established") after the handshake listener was removed.
async function startDroppingProxy() {
  const srv = createNetServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", () => {
      // resetAndDestroy => the client sees ECONNRESET during the TLS handshake.
      sock.resetAndDestroy ? sock.resetAndDestroy() : sock.destroy();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

test("testProxy: TLS wrapper errors never escape as uncaught exceptions", async (t) => {
  const proxy = await startDroppingProxy();
  t.after(() => proxy.close());
  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.removeListener("uncaughtException", onUncaught));

  const res = await testProxy(`http://127.0.0.1:${proxy.port}`, {
    host: "api.ipify.org", port: 443, timeout: 3000,
  });
  assert.equal(res.ok, false);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(errors.length, 0, "no uncaught exception: " + (errors[0] && errors[0].message));
});
