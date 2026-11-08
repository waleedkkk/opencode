import { test } from "node:test";
import assert from "node:assert/strict";
import { openProxyTunnel } from "../proxy-tunnel.mjs";
import { startFakeSocks5, startFakeHttpProxy, startEchoTarget } from "./helpers.mjs";

test("openProxyTunnel: socks5 without auth connects and relays data", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeSocks5();
  const sock = await openProxyTunnel(`socks5://127.0.0.1:${proxy.port}`, "127.0.0.1", target.port);
  sock.write("hello");
  const out = await new Promise((resolve) => {
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); if (buf.includes("ECHO:hello")) resolve(buf); });
    setTimeout(() => resolve(buf), 3000);
  });
  sock.destroy();
  await proxy.close();
  await target.close();
  assert.match(out, /ECHO:hello/);
});

test("openProxyTunnel: socks5 sends target as domain name (atyp=3)", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeSocks5();
  const sock = await openProxyTunnel(`socks5://127.0.0.1:${proxy.port}`, "localhost", target.port);
  sock.destroy();
  await proxy.close();
  await target.close();
  assert.equal(proxy.state.connects.length, 1);
  assert.equal(proxy.state.connects[0].atyp, 3, "must use domain so DNS happens at the proxy");
  assert.equal(proxy.state.connects[0].host, "localhost");
});

test("openProxyTunnel: socks5 performs username/password auth when required", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeSocks5({ requireAuth: true, user: "u1", pass: "p1" });
  const sock = await openProxyTunnel(`socks5://u1:p1@127.0.0.1:${proxy.port}`, "127.0.0.1", target.port);
  sock.destroy();
  await proxy.close();
  await target.close();
  assert.deepEqual(proxy.state.auths, [{ user: "u1", pass: "p1" }]);
});

test("openProxyTunnel: socks5 rejects when credentials are wrong", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeSocks5({ requireAuth: true, user: "u1", pass: "p1" });
  await assert.rejects(
    () => openProxyTunnel(`socks5://u1:wrong@127.0.0.1:${proxy.port}`, "127.0.0.1", target.port),
    /auth/i
  );
  await proxy.close();
  await target.close();
});

test("openProxyTunnel: socks5 surfaces proxy refusal", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeSocks5({ reject: true });
  await assert.rejects(
    () => openProxyTunnel(`socks5://127.0.0.1:${proxy.port}`, "127.0.0.1", target.port),
    /refus|reject|fail/i
  );
  await proxy.close();
  await target.close();
});

test("openProxyTunnel: http proxy uses CONNECT with Proxy-Authorization", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeHttpProxy();
  const sock = await openProxyTunnel(`http://user:pass@127.0.0.1:${proxy.port}`, "127.0.0.1", target.port);
  sock.write("ping");
  const out = await new Promise((resolve) => {
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); if (buf.includes("ECHO:ping")) resolve(buf); });
    setTimeout(() => resolve(buf), 3000);
  });
  sock.destroy();
  await proxy.close();
  await target.close();
  assert.match(out, /ECHO:ping/);
  assert.equal(proxy.state.connects.length, 1);
  assert.equal(proxy.state.connects[0].url, "127.0.0.1:" + target.port);
  assert.equal(proxy.state.connects[0].auth, "Basic " + Buffer.from("user:pass").toString("base64"));
});

test("openProxyTunnel: http proxy refusal rejects", async () => {
  const target = await startEchoTarget();
  const proxy = await startFakeHttpProxy({ reject: true });
  await assert.rejects(
    () => openProxyTunnel(`http://127.0.0.1:${proxy.port}`, "127.0.0.1", target.port),
    /refus|reject|fail|forbidden/i
  );
  await proxy.close();
  await target.close();
});

test("openProxyTunnel: unsupported scheme rejects", async () => {
  await assert.rejects(() => openProxyTunnel("ftp://127.0.0.1:1080", "127.0.0.1", 80), /scheme|support/i);
});
