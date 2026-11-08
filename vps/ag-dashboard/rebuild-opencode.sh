#!/bin/sh
# =============================================================================
# rebuild-opencode.sh — safe image swap for opencode-server
#
# USAGE (host, preferred):
#     sh /root/opencode-docker/workspace/ag-dashboard/rebuild-opencode.sh [TAG]
#
# USAGE (helper container, for when the agent session lives inside the target):
#     docker run --rm --privileged --pid=host \
#       -v /var/run/docker.sock:/var/run/docker.sock \
#       -v /root/opencode-docker/data:/data \
#       -v /root/opencode-docker/workspace:/wspace \
#       -e OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
#       docker:cli sh /wspace/ag-dashboard/rebuild-opencode.sh [TAG]
#
# ENV:
#     CHECK_ONLY=1   run preflight only, change nothing
#
# -----------------------------------------------------------------------------
# FIXES (2026-11-03):
#   1. BUG: persistent-dir preflight used HOST paths (/root/opencode-docker/...)
#      while the script normally runs INSIDE a helper container where the data
#      directory is mounted at /data. Every run therefore died with the fake
#      error "FATAL: مجلد دائم مفقود: /root/opencode-docker/data/persistent/config".
#      Now the script auto-detects /data vs host path, and keeps a separate
#      HOST_DATA variable for the `-v` sources (which must stay host paths).
#   2. BUG: port probe for 4096 used 0x0FA0 (=4000). Correct is 0x1000.
#   3. BUG: hard-failed when opencode-server did not exist (nothing to rename).
#      Now it creates from scratch; rollback simply reports that no rollback
#      container exists.
#   4. NEW: target tag is an argument (default 1.19.5), so the same script
#      upgrades to any version.
#   5. NEW: CHECK_ONLY=1 dry-run, and a container-inspect snapshot before create.
# =============================================================================
set -u

NEW_NAME=opencode-server
OLD_NAME=opencode-server-rollback
TAG=${1:-1.19.5}
IMAGE="ghcr.io/anomalyco/opencode:${TAG}"
HERMES_OLD_IP=172.27.0.10
CHECK_ONLY=${CHECK_ONLY:-0}

HOST_DATA=/root/opencode-docker/data
HOST_WS=/root/opencode-docker/workspace

# --- detect runtime context (host vs helper container) ----------------------
if [ -d /data/persistent ]; then DATA=/data; else DATA=$HOST_DATA; fi
if [ -d /wspace/ag-dashboard ]; then WS=/wspace; else WS=$HOST_WS; fi
PERSIST_HOST=$HOST_DATA/persistent
PERSIST_CHECK=$DATA/persistent
REPORT=$WS/REBUILD-REPORT.md
COMPOSE=$WS/../docker-compose.yml

say()  { echo "[$(date -u '+%H:%M:%S')] $*" | tee -a "$REPORT"; }
step() { say ""; say "=== $* ==="; }
die()  { say "FATAL: $*"; rollback "fatal: $*"; exit 1; }

# ---------------------------------------------------------------- host helpers
host() { nsenter -t 1 -m -u -i -n -p -- sh -c "$1"; }

container_ip() {
  docker inspect -f "{{with index .NetworkSettings.Networks \"hermes-net\"}}{{.IPAddress}}{{end}}" "$1" 2>/dev/null
}

exists() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }

fix_hermes_nginx() {
  ip="$1"
  if [ -z "$ip" ]; then say "⚠ no IP on hermes-net — skipping nginx fix"; return; fi
  host "sed -i 's/${HERMES_OLD_IP}:9119/${ip}:9119/g; s/[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*:9119/${ip}:9119/g' /etc/nginx/sites-available/hermeswd.duckdns.org 2>/dev/null; nginx -t >/dev/null 2>&1 && (systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null) && echo NGINX_RELOADED"
  say "✔ nginx hermeswd → ${ip}:9119"
}

# LISTEN check on a port inside the container. $1 = hex port (4096=1000, 8899=22C3, 9119=239F)
port_up() {
  docker exec "$NEW_NAME" sh -c "grep -qi ':$1 ' /proc/net/tcp /proc/net/tcp6 2>/dev/null" 2>/dev/null
}

get_pass() {
  p=""
  if exists "$NEW_NAME"; then
    p=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NEW_NAME" 2>/dev/null | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' | head -1)
  fi
  if [ -z "$p" ] && [ -f "$COMPOSE" ]; then
    p=$(sed -n 's/^[[:space:]]*OPENCODE_SERVER_PASSWORD:[[:space:]]*//p' "$COMPOSE" | head -1 | sed 's/[[:space:]]*$//')
  fi
  if [ -z "$p" ]; then p=${OPENCODE_SERVER_PASSWORD:-}; fi
  printf '%s' "$p" | sed 's/^"//; s/"$//'
}

# ------------------------------------------------------------------- rollback
rollback() {
  say ""
  say "=== ROLLBACK ($1) ==="
  if exists "$NEW_NAME"; then
    cur=$(docker inspect -f '{{.Config.Image}}' "$NEW_NAME" 2>/dev/null)
    if [ "$cur" = "$IMAGE" ]; then
      docker rm -f "$NEW_NAME" >/dev/null 2>&1 && say "  removed target container ($cur)"
    fi
  fi
  if exists "$OLD_NAME"; then
    docker rename "$OLD_NAME" "$NEW_NAME" >/dev/null 2>&1 && say "  restored name of old container"
    docker start "$NEW_NAME" >/dev/null 2>&1 && say "  old container restarted"
    oldip=$(container_ip "$NEW_NAME"); [ -n "$oldip" ] && fix_hermes_nginx "$oldip"
  else
    say "  NOTE: no '$OLD_NAME' container exists (it was already deleted before this run)."
    say "  To go back, re-run this script with the previous tag, e.g.:"
    say "      sh $WS/ag-dashboard/rebuild-opencode.sh <previous-tag>"
  fi
}

# =============================================================== 0. preflight
step "0) preflight (target: $IMAGE)"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  say "  image missing — pulling $IMAGE"
  docker pull "$IMAGE" >/dev/null 2>&1 || die "image pull failed"
fi
say "  ✔ image present"

for d in config cache hermes localbin state; do
  [ -d "$PERSIST_CHECK/$d" ] || die "persistent dir missing: $PERSIST_CHECK/$d"
done
say "  ✔ 5 persistent dirs present ($PERSIST_CHECK)"

if exists "$NEW_NAME"; then
  say "  ✔ container exists: $(docker inspect -f '{{.Config.Image}}' "$NEW_NAME")"
else
  say "  ℹ $NEW_NAME does not exist — will be created from scratch"
fi

PASS=$(get_pass)
if [ -z "$PASS" ]; then
  die "cannot resolve OPENCODE_SERVER_PASSWORD (container, compose file and env all empty)"
fi
say "  ✔ password resolved (len=${#PASS})"

if [ "$CHECK_ONLY" = "1" ]; then
  say "  CHECK_ONLY=1 — stopping here, nothing was changed"
  exit 0
fi

# ============================================================ 1. stop + rename
if exists "$NEW_NAME"; then
  if [ "$(docker inspect -f '{{.Config.Image}}' "$NEW_NAME")" = "$IMAGE" ]; then
    step "1) $NEW_NAME already runs $TAG — skipping recreate"
  else
    step "1) stop + rename current container (rollback point)"
    docker stop -t 30 "$NEW_NAME" >/dev/null 2>&1 || say "  ⚠ stop returned non-zero"
    docker rename "$NEW_NAME" "$OLD_NAME" >/dev/null 2>&1 || die "rename failed"
    say "  ✔ $OLD_NAME (stopped, ready for rollback)"
  fi
else
  step "1) no existing container — nothing to rename"
fi

# ================================================================ 2. create
if ! exists "$NEW_NAME"; then
  step "2) create $NEW_NAME on $TAG"
  mkdir -p "$DATA/config-backup" 2>/dev/null
  if exists "$OLD_NAME"; then
    docker inspect "$OLD_NAME" > "$DATA/config-backup/inspect-$OLD_NAME-$(date +%Y%m%d-%H%M%S).json" 2>/dev/null || true
  fi
  docker create --name "$NEW_NAME" \
    --restart unless-stopped \
    --network bridge \
    -p 4096:4096 \
    -e OPENCODE_SERVER_PASSWORD="$PASS" \
    -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    -w / \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$HOST_DATA:/root/.local/share/opencode" \
    -v "$HOST_WS:/workspace" \
    -v /usr/bin/docker:/usr/bin/docker \
    -v /usr/libexec/docker/cli-plugins:/usr/libexec/docker/cli-plugins \
    -v "$PERSIST_HOST/config:/root/.config/opencode" \
    -v "$PERSIST_HOST/cache:/root/.cache/opencode" \
    -v "$PERSIST_HOST/hermes:/root/.hermes" \
    -v "$PERSIST_HOST/localbin:/root/.local/bin" \
    -v "$PERSIST_HOST/state:/root/.local/state/opencode" \
    -v "$PERSIST_HOST/home-extra/.ssh:/root/.ssh" \
    -v "$PERSIST_HOST/home-extra/.docker:/root/.docker" \
    -v "$PERSIST_HOST/home-extra/.bashrc:/root/.bashrc" \
    -v "$PERSIST_HOST/home-extra/.profile:/root/.profile" \
    --entrypoint opencode "$IMAGE" serve --hostname 0.0.0.0 --port 4096 >/dev/null \
    || die "docker create failed"
  say "  ✔ created (14 mounts)"

  step "3) attach networks"
  for n in ag-net hermes-net mcp-net opencode-docker_default; do
    if docker network connect "$n" "$NEW_NAME" >/dev/null 2>&1; then say "  ✔ $n"; else say "  ⚠ $n"; fi
  done
fi

# ================================================================== 4. start
step "4) start + wait for serve on 4096"
docker start "$NEW_NAME" >/dev/null 2>&1 || die "start failed"
ok=0; i=0
while [ $i -lt 60 ]; do
  sleep 2; i=$((i+1))
  if port_up 1000; then ok=1; break; fi
done
[ $ok -eq 1 ] || die "port 4096 did not open within 120s"
say "  ✔ listening on 4096 after ~$((i*2))s"
docker inspect -f '  image={{.Config.Image}} started={{.State.StartedAt}}' "$NEW_NAME" | tee -a "$REPORT"

# ================================================================ 5. restore
step "5) restore-container-env.sh"
docker exec "$NEW_NAME" sh /workspace/ag-dashboard/restore-container-env.sh 2>&1 | tail -5 | tee -a "$REPORT" || say "  ⚠ restore returned non-zero"
sleep 5
docker exec "$NEW_NAME" sh -c 'command -v node' >/dev/null 2>&1 || {
  say "  ⚠ node missing — apk retry"
  docker exec "$NEW_NAME" apk add --no-cache nodejs 2>&1 | tail -2 | tee -a "$REPORT"
}
docker exec "$NEW_NAME" sh -c 'ps -e -o args 2>/dev/null | grep -q "[s]erver.mjs 8899"' 2>/dev/null \
  && say "  ✔ dashboard running on 8899" || say "  ⚠ dashboard not up yet (dash-watchdog retries every 30s)"

# ================================================================== 6. hermes
step "6) hermes dashboard on 9119"
if docker exec "$NEW_NAME" sh -c 'test -x /root/.local/bin/hermes' 2>/dev/null; then
  docker exec -d "$NEW_NAME" sh -c 'mkdir -p /tmp/opencode && cd /root/.hermes && setsid /root/.local/bin/hermes dashboard --host 0.0.0.0 --port 9119 --no-open >>/tmp/opencode/hermes.log 2>&1' >/dev/null 2>&1
  sleep 12
  port_up 239F && say "  ✔ 9119 listening" || say "  ⚠ 9119 not listening (see /tmp/opencode/hermes.log)"
else
  say "  ℹ hermes binary not found — skipped"
fi

# ================================================================== 7. nginx
step "7) fix nginx upstream for hermeswd"
NEWIP=$(container_ip "$NEW_NAME")
say "  hermes-net IP: ${NEWIP:-unknown}"
fix_hermes_nginx "$NEWIP"

# ============================================================== 8. verify
step "8) health checks"
hc() {
  code=$(docker exec "$NEW_NAME" sh -c "wget -q -O /dev/null --server-response '$2' 2>&1 | awk '/HTTP\\//{print \$2; exit}'" 2>/dev/null | tr -d '\r')
  if [ "$code" = "$3" ]; then say "  ✔ $1 → $code"; else say "  ⚠ $1 → ${code:-no-response} (expected $3)"; fi
}
hc "opencode  :4096" "http://127.0.0.1:4096/"  "401"
hc "dashboard :8899" "http://127.0.0.1:8899/"  "401"
hc "hermes    :9119" "http://127.0.0.1:9119/"  "302"

step "9) result"
say "✔ opencode-server is now on $TAG"
say "  rollback:  docker rename $OLD_NAME $NEW_NAME && docker start $NEW_NAME"
say "  report:    $REPORT"
cp "$REPORT" "$DATA/REBUILD-REPORT.md" 2>/dev/null || true
exit 0
