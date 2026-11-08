import fs from "node:fs";
// Test helpers: fake SOCKS5 / HTTP CONNECT proxy servers + local HTTPS target.
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:tls";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let certCache = null;
export function selfSignedCert() {
  if (certCache) return certCache;
  const dir = mkdtempSync(join(tmpdir(), "proxytest-"));
  const key = join(dir, "k.pem");
  const crt = join(dir, "c.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", crt, "-days", "2",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  certCache = { key: readFileSync(key), cert: readFileSync(crt) };
  return certCache;
}

// A plain TCP target that echoes what it receives and reports its own IP.
export async function startEchoTarget() {
  const srv = createNetServer((sock) => {
    sock.on("error", () => {});
    sock.on("data", (d) => sock.write("ECHO:" + d.toString()));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { port, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

// A TLS target serving a fixed body, reporting the observed client IP.
export async function startHttpsTarget(body = "1.2.3.4") {
  const { key, cert } = selfSignedCert();
  const srv = createHttpsServer({ key, cert }, (req, res) => {
    const ip = req.socket.remoteAddress || "";
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(body === "IP" ? ip : body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return {
    port,
    close: () => new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(r);
      srv.unref?.();
    }),
  };
}

// Fake SOCKS5 server. options: { user, pass, requireAuth }
export async function startFakeSocks5(options = {}) {
  const state = { connects: [], auths: [] };
  const srv = createNetServer((sock) => {
    sock.on("error", () => {});
    let stage = "greeting";
    let buf = Buffer.alloc(0);
    const handle = () => {
      for (;;) {
        if (stage === "greeting") {
          if (buf.length < 2) return;
          const n = buf[1];
          state.methods = [...buf.slice(2, 2 + n)];
          buf = buf.slice(2 + n);
          if (options.requireAuth) {
            sock.write(Buffer.from([0x05, 0x02]));
            stage = "auth";
          } else {
            sock.write(Buffer.from([0x05, 0x00]));
            stage = "request";
          }
          continue;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const user = buf.slice(2, 2 + ulen).toString();
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const pass = buf.slice(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.slice(3 + ulen + plen);
          state.auths.push({ user, pass });
          const ok = options.user === user && options.pass === pass;
          sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) { stage = "done"; sock.end(); return; }
          stage = "request";
          continue;
        }
        if (stage === "request") {
          if (buf.length < 4) return;
          const ver = buf[0], cmd = buf[1], atyp = buf[3];
          let host, off;
          if (atyp === 0x01) { host = [...buf.slice(4, 8)].join("."); off = 8; }
          else if (atyp === 0x03) { const l = buf[4]; if (buf.length < 5 + l + 2) return; host = buf.slice(5, 5 + l).toString(); off = 5 + l; }
          else { host = "::" + buf.slice(4, 20).toString("hex"); off = 20; }
          const port = buf.readUInt16BE(off);
          buf = buf.slice(off + 2);
          state.connects.push({ ver, cmd, atyp, host, port });
          stage = "relay";
          if (options.reject) {
            sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            sock.end();
            return;
          }
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          const up = netConnect(port, host, () => {
            sock.pipe(up); up.pipe(sock);
          });
          up.on("error", () => sock.destroy());
          return;
        }
        return; // relay stage: data is piped, never parsed
      }
    };
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); handle(); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { port, state, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

// Fake HTTP proxy supporting CONNECT (and optionally plain http forward).
export async function startFakeHttpProxy(options = {}) {
  const state = { connects: [], auth: [] };
  const srv = createServer((req, res) => {
    state.auth.push(req.headers["proxy-authorization"] || null);
    res.writeHead(400); res.end("only connect");
  });
  srv.on("connect", (req, clientSocket, head) => {
    state.connects.push({ url: req.url, host: req.headers.host, auth: req.headers["proxy-authorization"] || null });
    if (options.reject) { clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return clientSocket.end(); }
    const [host, portStr] = req.url.split(":");
    const up = netConnect(Number(portStr), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      clientSocket.pipe(up); up.pipe(clientSocket);
    });
    up.on("error", () => clientSocket.destroy());
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { port, state, close: () => new Promise((r) => { srv.close(r); srv.unref?.(); }) };
}

// A CONNECT proxy that always relays to one fixed upstream, whatever port
// the client asked for. This gives every proxy in the pool its own upstream,
// so a test can make one proxy "poisoned" and another one healthy.
export async function startReroutingHttpProxy({ upstreamPort, upstreamHost = "127.0.0.1" }) {
  const state = { connects: [] };
  const sockets = new Set();
  const srv = createServer((req, res) => { res.writeHead(400); res.end("only connect"); });
  srv.on("connect", (req, clientSocket, head) => {
    state.connects.push(req.url);
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    const up = netConnect(upstreamPort, upstreamHost, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      clientSocket.pipe(up); up.pipe(clientSocket);
    });
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    up.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => {});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return {
    port,
    state,
    close: () => new Promise((r) => {
      // The tunnel sockets are detached from the server, so they must go first.
      for (const s of sockets) { try { s.destroy(); } catch {} }
      sockets.clear();
      srv.close(r);
      srv.unref?.();
    }),
  };
}

// An HTTPS target whose reply is produced by the given handler.
export async function startScriptedHttpsTarget(handler) {
  const { key, cert } = selfSignedCert();
  const srv = createHttpsServer({ key, cert }, handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return {
    port,
    close: () => new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(r);
      srv.unref?.();
    }),
  };
}

// The dashboard password is not part of the repository: the tests read the
// same credentials file the server reads at runtime.
export function readAdminAuth() {
  const readFileSync = fs.readFileSync;
  const file = process.env.AG_DASHBOARD_AUTH || "/root/.local/share/opencode/ag-dashboard-auth";
  const creds = JSON.parse(readFileSync(file, "utf8"));
  return creds.admin;
}
