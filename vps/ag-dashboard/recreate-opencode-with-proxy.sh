#!/bin/sh
# =============================================================================
# recreate-opencode-with-proxy.sh   (POSIX sh — works with dash/busybox/bash)
# Wrapper: run the recreate script from the HOST (or from a helper container).
#
#   ./recreate-opencode-with-proxy.sh --dry-run          # plan only, safe
#   ./recreate-opencode-with-proxy.sh                     # perform recreate
#   ./recreate-opencode-with-proxy.sh --smoke opencode/crouton-alpha-free
#   ./recreate-opencode-with-proxy.sh --rollback          # undo
#
# The script must NOT run inside the `opencode-server` container itself: that
# container is stopped during the recreate and would take the script with it.
# The wrapper detects this and refuses to continue.
# =============================================================================
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/recreate-opencode-with-proxy.mjs"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
TARGET="${TARGET:-opencode-server}"

log() { printf '%s\n' "$*"; }

[ -f "$SCRIPT" ] || { log "✗ missing $SCRIPT"; exit 1; }
[ -S "$DOCKER_SOCK" ] || { log "✗ docker socket not found at $DOCKER_SOCK"; exit 1; }

# --- guard: refuse to run from inside the target container ------------------
if command -v docker >/dev/null 2>&1; then
  TARGET_ID=$(docker inspect -f '{{.Id}}' "$TARGET" 2>/dev/null || echo "")
  MY_HOST=$(hostname 2>/dev/null || echo "")
  if [ -n "$TARGET_ID" ]; then
    SHORT_ID=$(printf '%s' "$TARGET_ID" | cut -c1-12)
    case "$MY_HOST" in
      "$SHORT_ID"*)
        log "✗ refusing to run inside the target container ($TARGET)."
        log "  Run this from the host shell, or use the helper-container command below."
        log "  docker run --rm --network host -v $DOCKER_SOCK:$DOCKER_SOCK \\"
        log "    -v /root/opencode-docker/workspace:/w ${TARGET_IMAGE:-ghcr.io/anomalyco/opencode:2.2.5} \\"
        log "    node /w/ag-dashboard/recreate-opencode-with-proxy.mjs $*"
        exit 2
        ;;
    esac
  fi
fi

# --- locate a JS runtime ---------------------------------------------------
if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT" "$@"
fi

if command -v docker >/dev/null 2>&1; then
  IMAGE="${TARGET_IMAGE:-ghcr.io/anomalyco/opencode:2.2.5}"
  log "→ node not found on host; running the script in a helper container ($IMAGE)"
  log "  (it drives the recreate through the docker socket; it is NOT the target container)"
  exec docker run --rm --network host \
    -e DOCKER_SOCK="$DOCKER_SOCK" \
    -v "$DOCKER_SOCK:$DOCKER_SOCK" \
    -v /root/opencode-docker/workspace:/w \
    -v /root/opencode-docker/v2/config:/root/.config/opencode:ro \
    "$IMAGE" \
    node /w/ag-dashboard/recreate-opencode-with-proxy.mjs "$@"
fi

log "✗ neither node nor docker CLI found on this host."
log "  Install node, or run the .mjs with any Node 18+ runtime that can reach $DOCKER_SOCK."
exit 3
