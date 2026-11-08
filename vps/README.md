# VPS branch — Antigravity accounts dashboard + opencode proxy tunnel

This branch (`vps/antigravity-dashboard`) carries the operational work that runs on our
VPS: a small dashboard for Antigravity accounts, a plugin that keeps the Antigravity
identity in a config file, and the proxy tunnel that makes the geo-blocked `opencode`
provider models work.

It is based on the fork's `dev` branch. The directories below are additions — no core
`opencode` source file is modified.

## Layout

```
vps/
├── ag-dashboard/          # the dashboard (plain Node, no dependencies)
│   ├── server.mjs         # HTTP server: UI + JSON API (port 8899)
│   ├── oc-container-proxy.mjs  # proxy state = container env; drives the recreate script
│   ├── recreate-opencode-with-proxy.mjs  # recreate with/without the CONNECT tunnel
│   ├── proxy-*.mjs        # proxy pool, policy, failover, tunnel
│   ├── restore-container-env.sh  # re-install node+openssl, restart the dashboard
│   └── test/              # node:test suites (101 tests)
└── opencode-config/       # files installed into ~/.config/opencode
    ├── plugins/antigravity/index.js
    ├── antigravity-identity.mjs
    └── antigravity-identity.json
```

## What the dashboard does

- Lists Antigravity Google accounts (21) and probes them. Result of the last run:
  `daily` → 200, `autopush` → 403, `prod` → 429 (quota).
- Shows the **real** state of the proxy tunnel by reading `HTTPS_PROXY` from the
  `opencode-server` container environment — not by grepping a config file. The old
  string grep reported "enabled" while traffic went out directly.
- Toggling the tunnel recreates the container (Docker's `POST /containers/<id>/update`
  ignores `Env`), keeps a backup container, and offers a rollback button.

## Why a CONNECT tunnel

Measured 2026-11-08, same minute, same headers:

| Transport | Result |
|---|---|
| Bun (opencode client) through the dashboard's HTTP proxy (Node terminates TLS) | `429 FreeUsageLimitError` |
| Bun through a CONNECT tunnel (client keeps its own TLS) | `200` |

So the tunnel lives in the container environment:

```
HTTPS_PROXY=http://<user>:<pass>@dc.decodo.com:10001
HTTP_PROXY=...
NO_PROXY=127.0.0.1,localhost,<internal hosts>
```

Exit address through the tunnel: `192.177.124.138` (US / California), which is why
`opencode/crouton-alpha-free` answers instead of `403 RegionError` (the VPS itself
egresses from France, Contabo).

## Tests

```sh
cd vps/ag-dashboard
node --test "test/*.test.mjs"     # 101 tests, 101 pass
```

## Security

No credentials are committed. Proxy URLs, account tokens and dashboard passwords are
read at runtime from files outside the repository. All proxy URLs in logs and API
responses are masked (`http://user:***@host:port`).

## Notes

- `opencode run` talks to a running server and ignores `OPENCODE_CONFIG`; isolated
  tests need `--standalone` with a temporary `XDG_CONFIG_HOME`.
- `--no-proxy` in `recreate-opencode-with-proxy.mjs` sets the `NO_PROXY` host list;
  removing the tunnel is `--drop-proxy`.
