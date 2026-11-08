import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTlsServer } from "node:tls";
import { connect as netConnect } from "node:net";
import { openProxyTunnel, testProxy } from "../proxy-tunnel.mjs";
import { startFakeSocks5, startFakeHttpProxy, startHttpsTarget, selfSignedCert } from "./helpers.mjs";

// A proxy that speaks HTTPS (TLS) then CONNECT — mirrors an https:// proxy URL.
// tls.Server does not parse HTTP, so the CONNECT request is handled manually.
async function startFakeHttpsProxy(options = {}) {
  const { key, cert } = selfSignedCert();
  const state = { connects: [] };
  const srv = createTlsServer({ key, cert }, (sock) => {
    let buf = Buffer.alloc(0);
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString();
      const rest = buf.slice(idx + 4);
      const m = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]/i.exec(head);
      if (!m) { sock.destroy(); return; }
      state.connects.push({ url: m[1] });
      if (options.reject) { sock.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return sock.end(); }
      const [host, portStr] = m[1].split(":");
      const up = netConnect(Number(portStr), host, () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) up.write(rest);
        sock.pipe(up); up.pipe(sock);
      });
      up.on("error", () => sock.destroy());
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

test("openProxyTunnel: https proxy does TLS to proxy then CONNECT", async () => {
  const target = await startHttpsTarget("BODY");
  const proxy = await startFakeHttpsProxy();
  const sock = await openProxyTunnel(`https://127.0.0.1:${proxy.port}`, "127.0.0.1", target.port);
  sock.destroy();
  await proxy.close();
  await target.close();
  assert.equal(proxy.state.connects.length, 1);
  assert.equal(proxy.state.connects[0].url, "127.0.0.1:" + target.port);
});

test("testProxy: returns the exit IP seen through an http proxy", async (t) => {
  const target = await startHttpsTarget("IP");
  const proxy = await startFakeHttpProxy();
  t.after(() => { proxy.close(); target.close(); });
  const res = await testProxy(`http://127.0.0.1:${proxy.port}`, {
    host: "127.0.0.1", port: target.port, path: "/", insecure: true,
  });
  assert.equal(res.ok, true, "expected ok, got " + JSON.stringify(res));
  assert.equal(res.ip, "127.0.0.1");
  assert.ok(typeof res.ms === "number" && res.ms >= 0);
});

test("testProxy: returns the exit IP seen through a socks5 proxy", async (t) => {
  const target = await startHttpsTarget("IP");
  const proxy = await startFakeSocks5();
  t.after(() => { proxy.close(); target.close(); });
  const res = await testProxy(`socks5://127.0.0.1:${proxy.port}`, {
    host: "127.0.0.1", port: target.port, path: "/", insecure: true,
  });
  assert.equal(res.ok, true, "expected ok, got " + JSON.stringify(res));
  assert.equal(res.ip, "127.0.0.1");
});

test("testProxy: reports failure with a reason when the proxy is dead", async () => {
  const res = await testProxy("http://127.0.0.1:9", { host: "127.0.0.1", port: 443, timeout: 3000 });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length > 0, "expected an error message");
});

test("testProxy: reports failure when target rejects", async (t) => {
  const proxy = await startFakeHttpProxy({ reject: true });
  t.after(() => proxy.close());
  const res = await testProxy(`http://127.0.0.1:${proxy.port}`, {
    host: "127.0.0.1", port: 443, timeout: 3000,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /refus|forbidden|fail/i);
});
