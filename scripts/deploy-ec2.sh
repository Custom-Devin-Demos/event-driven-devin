#!/usr/bin/env bash
# Safe deploy of an already-extracted release tree onto the EC2 demo host.
#
#   scripts/deploy-ec2.sh <staging-dir> [source-label]
#
# Runs ON the host (ubuntu@devindemos.com). Both source repos' "Deploy to EC2"
# workflows and the manual playbook deploy go through this script, so a deploy
# from either repo is:
#
#   - serialized      flock on $APP_DIR/.deploy.lock
#   - reversible      .env + the live tree are saved to $APP_DIR/releases/<ts>*
#                     and restored automatically if health/smoke fails
#   - a mirror        every top-level entry present in the staging tree is
#                     rsync'd with --delete, so retired files really go away
#   - additive for    app/routes/verticals, app/public/verticals,
#     verticals       app/services/verticals and config/customers are never
#                     deleted from the host: a demo added by the other repo
#                     keeps working until the sync PR lands here
#   - host-preserving .env*, .ssh, certbot/, docker-compose.override.yml,
#                     archive/, releases/ and anything else not in the staging
#                     tree are untouched
#   - verified        /health, every vertical page, every alias and a fixed
#                     list of critical paths must return 200 before loadgen
#                     and the rest of the stack are reconciled
#   - host-converged  scripts/host-bootstrap.sh runs every deploy (swap,
#                     persistent journald, the single vertical-guard cron)
#   - memory-aware    images are built one at a time; the box has ~1.9G RAM
set -euo pipefail

STAGING=${1:?usage: deploy-ec2.sh <staging-dir> [source-label]}
SOURCE_LABEL=${2:-manual}
APP_DIR=${APP_DIR:-/home/ubuntu}
RELEASES_DIR="$APP_DIR/releases"
KEEP_RELEASES=${KEEP_RELEASES:-5}
HEALTH_URL=${HEALTH_URL:-http://localhost:3000/health}
BASE_URL=${BASE_URL:-http://localhost:3000}
MIN_FREE_MB=${MIN_FREE_MB:-3072}

# Vertical registries: never deleted on the host (see header).
PROTECTED_APP=(routes/verticals public/verticals services/verticals)
PROTECTED_CONFIG=(customers)
# Host-only top-level entries that must never be replaced even if a staging
# tree happens to contain them.
NEVER_TOUCH=(.env .env.example.local .ssh certbot docker-compose.override.yml archive releases node_modules .git data)

CRITICAL_PATHS=(/ /health /retail /api/verticals /oncall /publix /qbe /4f645972)

TS=$(date +%s)
LOG_PREFIX="[deploy $TS $SOURCE_LABEL]"
log() { echo "$LOG_PREFIX $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

STAGING=$(cd "$STAGING" && pwd)
[ -f "$STAGING/docker-compose.yml" ] || die "$STAGING does not look like a release tree (no docker-compose.yml)"
cd "$APP_DIR"

compose() { docker compose "$@" 2> >(grep -v 'obsolete\|Bake' >&2 || true); }

# Slack is best-effort: only if the host .env carries a bot token + channel.
env_value() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true; }
notify() {
  local text="$1"
  local token channel
  token=$(env_value SLACK_BOT_TOKEN); channel=$(env_value SLACK_CHANNEL_ID)
  [ -n "$token" ] && [ -n "$channel" ] || return 0
  curl -s -o /dev/null -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    -d "$(jq -cn --arg c "$channel" --arg t "$text" '{channel:$c,text:$t}')" || true
}

# ── 0. lock ─────────────────────────────────────────────────────────────────
exec 8>"$APP_DIR/.deploy.lock"
if ! flock -w 900 8; then die "another deploy has held $APP_DIR/.deploy.lock for >15 min"; fi
log "lock acquired"

# ── 1. disk + backups ───────────────────────────────────────────────────────
docker image prune -f >/dev/null || true
AVAIL_MB=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$AVAIL_MB" -ge "$MIN_FREE_MB" ] || die "only ${AVAIL_MB}MB free on /, need ${MIN_FREE_MB}MB"

mkdir -p "$RELEASES_DIR"
cp -a "$APP_DIR/.env" "$RELEASES_DIR/env.$TS"
cp -a "$APP_DIR/.env" "$APP_DIR/.env.bak"

# Back up exactly the top-level entries this deploy will touch.
mapfile -t TOP_ENTRIES < <(cd "$STAGING" && ls -A)
TOUCHED=()
for e in "${TOP_ENTRIES[@]}"; do
  skip=0
  for n in "${NEVER_TOUCH[@]}"; do [ "$e" = "$n" ] && skip=1; done
  case "$e" in .env*) skip=1;; esac
  [ $skip = 1 ] && continue
  TOUCHED+=("$e")
done
EXISTING=()
for e in "${TOUCHED[@]}"; do [ -e "$APP_DIR/$e" ] && EXISTING+=("$e"); done
BACKUP="$RELEASES_DIR/$TS.tgz"
tar czf "$BACKUP" -C "$APP_DIR" --exclude=node_modules "${EXISTING[@]}"
log "backed up ${#EXISTING[@]} top-level entries to $BACKUP"
# retention
ls -1t "$RELEASES_DIR"/*.tgz 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f
ls -1t "$RELEASES_DIR"/env.* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f

rollback() {
  log "ROLLING BACK to $BACKUP"
  tar xzf "$BACKUP" -C "$APP_DIR"
  cp -a "$RELEASES_DIR/env.$TS" "$APP_DIR/.env"
  compose build -q checkout-api || true
  compose up -d --no-deps checkout-api || true
  for _ in $(seq 1 40); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)" = 200 ] && { log "rollback healthy"; return 0; }
    sleep 2
  done
  log "rollback did NOT come back healthy — manual attention required"
  return 1
}
fail() {
  notify ":rotating_light: devindemos.com deploy from *$SOURCE_LABEL* failed: $1 — rolled back to release $TS"
  rollback || true
  die "$1"
}

# ── 2. preflight report: verticals present live but not in staging ──────────
report_live_only() {
  local dir=$1 pattern=$2
  comm -23 <(cd "$APP_DIR" && ls "$dir"/$pattern 2>/dev/null | sort) \
           <(cd "$STAGING" && ls "$dir"/$pattern 2>/dev/null | sort)
}
LIVE_ONLY=$( { report_live_only app/routes/verticals '*.js'; report_live_only app/public/verticals '*.html'; report_live_only config/customers '*.js'; } | grep -v '^app/routes/verticals/index.js$' || true)
if [ -n "$LIVE_ONLY" ]; then
  log "preserving $(echo "$LIVE_ONLY" | wc -l) vertical file(s) that exist on the host but not in this release (other repo's demos, or sync pending):"
  echo "$LIVE_ONLY" | sed "s/^/$LOG_PREFIX    /"
fi

# ── 3. mirror the staging tree into place ───────────────────────────────────
for e in "${TOUCHED[@]}"; do
  if [ -d "$STAGING/$e" ]; then
    FILTERS=()
    if [ "$e" = app ]; then
      for p in "${PROTECTED_APP[@]}"; do FILTERS+=(--filter="P /$p/**"); done
    elif [ "$e" = config ]; then
      for p in "${PROTECTED_CONFIG[@]}"; do FILTERS+=(--filter="P /$p/**"); done
    fi
    rsync -a --delete --exclude=node_modules "${FILTERS[@]}" "$STAGING/$e/" "$APP_DIR/$e/"
  else
    cp -a "$STAGING/$e" "$APP_DIR/$e"
  fi
done
mkdir -p "$APP_DIR/certbot/conf" "$APP_DIR/certbot/www"
log "synced ${#TOUCHED[@]} top-level entries"

# ── 3b. converge host-level setup (swap, journald, guard cron) ──────────────
bash "$APP_DIR/scripts/host-bootstrap.sh" 2>&1 | sed "s/^/$LOG_PREFIX /" || log "warning: host bootstrap failed"

# ── 4. build + swap checkout-api ────────────────────────────────────────────
compose config -q || fail "docker compose config is invalid"
AVAIL_MEM_MB=$(awk '/^(MemAvailable|SwapFree):/ {s += $2} END {print int(s / 1024)}' /proc/meminfo)
log "building with ${AVAIL_MEM_MB}MB available (RAM + swap)"
# One image at a time: parallel builds are what OOM-hung the host.
compose build checkout-api >/dev/null || fail "checkout-api image build failed"
compose build loadgen >/dev/null || fail "loadgen image build failed"
compose up -d --no-deps checkout-api >/dev/null || fail "checkout-api failed to start"

STATUS=000
for _ in $(seq 1 40); do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)
  [ "$STATUS" = 200 ] && break
  sleep 2
done
[ "$STATUS" = 200 ] || fail "health check returned $STATUS after 80s"
log "health 200"

# ── 5. smoke every vertical page, alias and critical path ───────────────────
PAGES=$(cd "$APP_DIR/app/public/verticals" && ls *.html | sed 's/\.html$//; s#^#/#')
ALIASES=$(compose exec -T checkout-api node -e '
  const { listAliases } = require("/app/config/customers");
  console.log(Object.keys(listAliases()).map((a) => "/" + a).join("\n"));
' 2>/dev/null | grep '^/' || true)
FAILED=()
while read -r p; do
  [ -n "$p" ] || continue
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL$p" || true)
  [ "$code" = 200 ] || FAILED+=("$p=$code")
done < <(printf '%s\n' "${CRITICAL_PATHS[@]}" "$PAGES" "$ALIASES" | sort -u)
TOTAL=$(printf '%s\n' "${CRITICAL_PATHS[@]}" "$PAGES" "$ALIASES" | sort -u | grep -c .)
if [ ${#FAILED[@]} -gt 0 ]; then
  fail "smoke: ${#FAILED[@]}/$TOTAL paths not 200: ${FAILED[*]}"
fi
log "smoke ok ($TOTAL paths 200)"

# ── 6. reconcile the rest of the stack ──────────────────────────────────────
compose up -d --no-deps loadgen >/dev/null || log "warning: loadgen restart failed"
compose up -d >/dev/null || log "warning: compose up -d (reconcile) failed"
docker image prune -f >/dev/null || true

printf 'ts=%s\nsource=%s\nbackup=%s\n' "$TS" "$SOURCE_LABEL" "$BACKUP" > "$RELEASES_DIR/CURRENT"
log "deploy complete ($SOURCE_LABEL); rollback point: $BACKUP"
df -h / | tail -1
