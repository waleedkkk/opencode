// Proxy tunnel support: HTTP CONNECT, HTTPS (TLS to proxy), and SOCKS5.
// All three produce a raw TCP socket already connected to the target host:port.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const DEFAULT_TIMEOUT = 10000;

// Decode a chunked transfer body into its payload; plain bodies pass through.
export function decodeChunked(body) {
  if (!body) return "";
  if (!/^[0-9a-f]+[;\r\n]/i.test(body)) return body.trim();
  let out = "";
  let rest = body;
  for (;;) {
    const idx = rest.indexOf("\r\n");
    if (idx < 0) break;
    const size = parseInt(rest.slice(0, idx).split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = idx + 2;
    out += rest.slice(start, start + size);
    rest = rest.slice(start + size + 2);
  }
  return out.trim();
}

function parseProxyUrl(proxyUrl) {
  const u = new URL(proxyUrl);
  const scheme = u.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks5"].includes(scheme)) {
    throw new Error(`unsupported proxy scheme: ${scheme}`);
  }
  const port = u.port ? Number(u.port) : scheme === "socks5" ? 1080 : 8080;
  return {
    scheme,
    host: u.hostname,
    port,
    username: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- HTTP / HTTPS CONNECT -------------------------------------------------

function httpConnect(p, host, port, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sock = null;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      try { sock && sock.destroy(); } catch {}
      reject(new Error(msg));
    };
    const headers = { Host: `${host}:${port}` };
    if (p.username || p.password) {
      headers["Proxy-Authorization"] = "Basic " + Buffer.from(`${p.username}:${p.password}`).toString("base64");
    }
    sock = p.scheme === "https"
      ? tlsConnect({ host: p.host, port: p.port, servername: p.host, rejectUnauthorized: false })
      : netConnect({ host: p.host, port: p.port });
    // The error listener stays attached for the socket's whole life: a later
    // ECONNRESET must never become an uncaught exception.
    sock.on("error", (e) => {
      if (!settled) fail(`http proxy connect failed: ${e.message}`);
    });
    sock.setTimeout(timeout);
    sock.once("timeout", () => fail("http proxy connect timeout"));
    sock.once(p.scheme === "https" ? "secureConnect" : "connect", () => {
      sock.setTimeout(0);
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString();
        sock.removeListener("data", onData);
        const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] || 0);
        if (status !== 200) {
          fail(`http proxy refused connect: ${status || head.slice(0, 40)}`);
          return;
        }
        const rest = buf.slice(idx + 4);
        if (rest.length) sock.unshift(rest);
        settled = true;
        resolve(sock);
      };
      sock.on("data", onData);
    });
  });
}

// --- SOCKS5 ---------------------------------------------------------------

function socks5Connect(p, host, port, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sock = null;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      try { sock && sock.destroy(); } catch {}
      reject(new Error(`socks5 connect failed: ${msg}`));
    };
    sock = netConnect({ host: p.host, port: p.port });
    // Kept for the socket's whole life so a later reset is never uncaught.
    sock.on("error", (e) => {
      if (!settled) fail(e.message);
    });
    sock.setTimeout(timeout);
    sock.once("timeout", () => fail("socks5 connect timeout"));
    sock.once("connect", () => {
      // Offer no-auth (0x00) and user/pass (0x02).
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      let stage = "greeting";
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        if (stage === "greeting") {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) { fail(`bad socks5 version ${buf[0]}`); return; }
          const method = buf[1];
          buf = buf.slice(2);
          if (method === 0x00) { stage = "request"; sendRequest(); return; }
          if (method === 0x02) {
            if (!p.username) { fail("socks5 proxy requires auth but no credentials given"); return; }
            const u = Buffer.from(p.username, "utf8");
            const pw = Buffer.from(p.password, "utf8");
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
            stage = "auth";
            return;
          }
          fail(`socks5 proxy rejected auth methods (0x${method.toString(16)})`);
          return;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const status = buf[1];
          buf = buf.slice(2);
          if (status !== 0x00) { fail("socks5 auth failed"); return; }
          stage = "request";
          sendRequest();
          return;
        }
        if (stage === "request") {
          if (buf.length < 4) return;
          if (buf[1] !== 0x00) { fail(`socks5 proxy refused connect (code ${buf[1]})`); return; }
          sock.removeListener("data", onData);
          sock.setTimeout(0);
          settled = true;
          resolve(sock);
        }
      };
      const sendRequest = () => {
        // ATYP=3 (domain) so name resolution happens at the proxy.
        const name = Buffer.from(host, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf]));
      };
      sock.on("data", onData);
    });
  });
}

/**
 * Open a tunnel through `proxyUrl` to `host:port`.
 * Resolves with a connected net.Socket/tls.TLSSocket; caller owns it.
 */
export async function openProxyTunnel(proxyUrl, host, port, { timeout = DEFAULT_TIMEOUT } = {}) {
  const p = parseProxyUrl(proxyUrl);
  const promise = p.scheme === "socks5"
    ? socks5Connect(p, host, port, timeout)
    : httpConnect(p, host, port, timeout);
  return withTimeout(promise, timeout + 2000, "proxy tunnel");
}

/**
 * Probe a proxy by performing an HTTPS request through it and reading the
 * responder's address. Uses the exact same tunnel code as real traffic, so
 * a proxy that passes here can actually carry model requests.
 */
export async function testProxy(proxyUrl, {
  host = "api.ipify.org",
  port = 443,
  path = "/?format=json",
  timeout = DEFAULT_TIMEOUT,
  insecure = false,
} = {}) {
  const t0 = Date.now();
  let sock = null;
  let tlsSock = null;
  try {
    sock = await openProxyTunnel(proxyUrl, host, port, { timeout });
    // The raw socket can emit ECONNRESET after the TLS wrapper is torn down.
    // Without a listener that becomes an uncaught exception and kills the process.
    sock.on("error", () => {});
    const body = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
      tlsSock = tlsConnect({
        socket: sock,
        servername: host,
        rejectUnauthorized: !insecure,
      }, () => {
        tlsSock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: opencode-proxy-check\r\nAccept: */*\r\nConnection: close\r\n\r\n`
        );
      });
      // A permanent no-op listener: after the request settles the socket may
      // still emit errors (e.g. "socket disconnected before secure TLS
      // connection was established"). Those must never be uncaught.
      tlsSock.on("error", () => {});
      const onTlsError = (e) => settle(reject, new Error(`tls failed: ${e.message}`));
      const onTimeout = () => { tlsSock.destroy(); settle(reject, new Error("read timeout")); };
      let raw = "";
      tlsSock.setTimeout(timeout);
      tlsSock.on("error", onTlsError);
      tlsSock.on("timeout", onTimeout);
      tlsSock.on("data", (d) => { raw += d.toString(); });
      tlsSock.on("end", () => settle(resolve, raw));
      tlsSock.on("close", () => settle(resolve, raw));
    });
    const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(body)?.[1] || 0);
    if (status && status >= 400) throw new Error(`target returned HTTP ${status}`);
    const rawBody = body.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
    const text = decodeChunked(rawBody);
    let ip = "";
    try {
      const j = JSON.parse(text);
      ip = j.ip || j.origin || "";
    } catch {
      ip = text.split(/\s+/)[0] || "";
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.includes(":")) {
      throw new Error("no IP in response");
    }
    return { ok: true, ip, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 160), ms: Date.now() - t0 };
  } finally {
    try { tlsSock && tlsSock.destroy(); } catch {}
    try { sock && sock.destroy(); } catch {}
  }
}
