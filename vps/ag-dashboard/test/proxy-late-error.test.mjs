import { test } from "node:test";
import assert from "node:assert/strict";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { testProxy } from "../proxy-tunnel.mjs";

// An HTTP CONNECT proxy that completes the tunnel, lets the request finish,
// then resets the connection. The error arrives AFTER the response was read,
// i.e. after the TLS wrapper's error listener may have been removed.
async function startLateResetProxy() {
  const state = { resetAt: null };
  const srv = createNetServer((sock) => {
    sock.on("error", () => {});
    let upstream = null;
    sock.on("data", (d) => {
      if (!upstream) {
        // CONNECT request line
        const line = d.toString().split("\r\n")[0];
        const m = /CONNECT\s+(\S+)\s+HTTP/i.exec(line);
        if (!m) return;
        const [host, port] = m[1].split(":");
        upstream = netConnect(Number(port), host, () => {
          sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          sock.pipe(upstream);
          upstream.pipe(sock);
        });
        upstream.on("error", () => sock.destroy());
        // Reset the client a moment later — after the HTTP response completes.
        setTimeout(() => {
          state.resetAt = Date.now();
          sock.resetAndDestroy ? sock.resetAndDestroy() : sock.destroy();
        }, 400);
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

test("testProxy: an error arriving after the response is not uncaught", async (t) => {
  const { startHttpsTarget } = await import("./helpers.mjs");
  const target = await startHttpsTarget("1.2.3.4");
  const proxy = await startLateResetProxy();
  t.after(() => { proxy.close(); target.close(); });

  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.removeListener("uncaughtException", onUncaught));

  const res = await testProxy(`http://127.0.0.1:${proxy.port}`, {
    host: "127.0.0.1", port: target.port, path: "/", insecure: true, timeout: 4000,
  });
  assert.equal(res.ok, true, "expected a successful read, got " + JSON.stringify(res));
  assert.equal(res.ip, "1.2.3.4");

  // Wait past the proxy's reset so the late error lands.
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(errors.length, 0, "no uncaught exception: " + (errors[0] && errors[0].message));
});
