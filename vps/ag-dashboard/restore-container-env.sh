#!/bin/sh
# Re-run after ANY opencode-server recreate. Restores everything the
# container image lacks but the stack needs:
#   1. nodejs  (dashboard server.mjs)
#   2. B' soft-quota patch on opencode-ag-auth (re-downloaded lazily by
#      opencode on first run needing it — this script re-applies after)
#   3. dashboard process on :8899
# NOTE: docker-cli is intentionally NOT installed: /usr/bin/docker is a
# host bind-mount (glibc binary, unusable on musl Alpine) and shadows any
# apk package. Run docker commands via the dash-watchdog container instead.
set -e
command -v node >/dev/null || apk add --no-cache nodejs
# openssl: the proxy test-suite generates self-signed certs with it
# (test/helpers.mjs selfSignedCert) — without it 20 proxy tests fail with
# "spawnSync openssl ENOENT" right after a container recreate.
command -v openssl >/dev/null || apk add --no-cache openssl
if [ -d /root/.cache/opencode/packages/opencode-ag-auth@latest ]; then
  node /workspace/ag-dashboard/patches/apply-softquota-patch.mjs || true
else
  echo "plugin cache not present yet (installs on first opencode run needing it); re-run me afterwards to apply the B' patch"
fi
mkdir -p /tmp/opencode
if ps -e -o args | grep -q "[s]erver.mjs 8899"; then
  echo "dashboard already running"
else
  setsid nohup node /workspace/ag-dashboard/server.mjs 8899 >/tmp/opencode/dash.log 2>&1 < /dev/null &
  echo "dashboard started"
fi
echo RESTORED
