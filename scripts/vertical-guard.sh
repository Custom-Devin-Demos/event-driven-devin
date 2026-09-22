#!/usr/bin/env bash
# Single cron guard for the EC2 demo host (installed by scripts/host-bootstrap.sh,
# runs every 5 min). Replaces the per-vertical hcf/qbe/suncorp/insignia/hub24/cfs
# guards, which each ran `docker compose up -d --build` on any non-200 and
# together OOM-hung the box when they all fired after a deploy.
#
# Rules:
#   - never builds       a broken image is a deploy's job, not a cron's
#   - never races        skips while scripts/deploy-ec2.sh holds .deploy.lock
#   - post-deploy grace  skips for GRACE_SECONDS after the last deploy so the
#                        app's own restart/warm-up does not look like an outage
#   - restart only       `compose up -d --no-build` then `compose restart`,
#                        at most once per COOLDOWN_SECONDS
#   - missing files      are reported, not "repaired": the deploy's
#                        vertical-protection rules own what lives on the host
set -u

APP_DIR=${APP_DIR:-/home/ubuntu}
BASE_URL=${BASE_URL:-http://127.0.0.1:3000}
LOG_FILE="$APP_DIR/vertical-guard.log"
STAMP_FILE="$APP_DIR/.vertical-guard.last-restart"
COOLDOWN_SECONDS=${COOLDOWN_SECONDS:-600}
GRACE_SECONDS=${GRACE_SECONDS:-900}
# Paths that must return 200. /health first; the rest are the demos the legacy
# guards watched. Override with GUARD_PATHS="/a /b".
PATHS=(${GUARD_PATHS:-/health /hcf /qbe /suncorp /insignia /hub24 /cfs})

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
compose() { docker compose "$@" 2> >(grep -v 'obsolete\|Bake' >&2 || true); }
notify() {
  [ -f "$APP_DIR/scripts/ops-notify.sh" ] || return 0
  bash "$APP_DIR/scripts/ops-notify.sh" "$1" "${2:-}" || true
}
http_status() { curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$BASE_URL$1" 2>/dev/null || printf '000'; }

cd "$APP_DIR" || exit 1

exec 9>"$APP_DIR/.deploy.lock"
if ! flock -n 9; then
  log 'deploy in progress (.deploy.lock held), skipping'
  exit 0
fi

now=$(date +%s)
last_deploy=$(sed -n 's/^ts=//p' "$APP_DIR/releases/CURRENT" 2>/dev/null | head -1)
case "$last_deploy" in ''|*[!0-9]*) last_deploy=0 ;; esac
if [ $((now - last_deploy)) -lt "$GRACE_SECONDS" ]; then
  log "post-deploy grace ($((now - last_deploy))s since deploy), skipping"
  exit 0
fi

check() {
  FAILED=()
  for p in "${PATHS[@]}"; do
    code=$(http_status "$p")
    [ "$code" = 200 ] || FAILED+=("$p=$code")
  done
  [ ${#FAILED[@]} -eq 0 ]
}

if check; then
  log "healthy (${#PATHS[@]} paths 200)"
  exit 0
fi
log "unhealthy: ${FAILED[*]}"

MISSING=()
for p in "${PATHS[@]}"; do
  [ "$p" = /health ] && continue
  slug=${p#/}
  [ -f "app/public/verticals/$slug.html" ] || MISSING+=("$slug")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  log "vertical files missing on host (needs a deploy, not a restart): ${MISSING[*]}"
  notify "[devindemos] guard: vertical files missing on host" \
    "Missing: ${MISSING[*]}

A redeploy is needed; the guard does not repair files. Log: $LOG_FILE"
fi

last=$(cat "$STAMP_FILE" 2>/dev/null || printf '0')
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ $((now - last)) -lt "$COOLDOWN_SECONDS" ]; then
  log "restart cooldown active ($((now - last))s since last restart)"
  exit 0
fi
printf '%s\n' "$now" > "$STAMP_FILE"

log "restarting checkout-api (no build)"
compose up -d --no-deps --no-build checkout-api >> "$LOG_FILE" 2>&1 || log 'compose up failed'
for _ in $(seq 1 20); do check && break; sleep 3; done
if ! check; then
  compose restart --no-deps checkout-api >> "$LOG_FILE" 2>&1 || log 'compose restart failed'
  for _ in $(seq 1 20); do check && break; sleep 3; done
fi

if check; then
  log "recovered after restart"
  exit 0
fi
log "still unhealthy after restart: ${FAILED[*]}"
notify "[devindemos] guard: still unhealthy after restart" \
  "Non-200 after compose restart: ${FAILED[*]}

Host: $(hostname). Log: $LOG_FILE"
exit 1
