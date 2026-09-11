#!/usr/bin/env bash
# Idempotent host-level setup for the EC2 demo host. Called by
# scripts/deploy-ec2.sh on every deploy so the host never drifts from what the
# repo describes; safe to run by hand at any time:
#
#   bash scripts/host-bootstrap.sh
#
# Ensures:
#   - swap        a 2G /swapfile (t3.small has 1.9G RAM and no swap by
#                 default; a docker build on top of the resident stack OOM-hung
#                 the box on 2026-09-11)
#   - journald    persistent, capped storage so the previous boot's kernel log
#                 survives a hard reboot
#   - guard cron  a single scripts/vertical-guard.sh entry replaces the
#                 per-vertical *-guard.sh copies that used to rebuild images
#                 concurrently
#   - ops-notify  python3 + boto3 so scripts/ops-notify.sh can publish
#                 deploy/guard alerts to SNS (instance role)
#
# Everything privileged goes through `sudo -n`; when passwordless sudo is not
# available the swap/journald steps are logged and skipped. The guard cron is
# the one mandatory result: the script exits non-zero unless the crontab ends
# up with exactly one vertical-guard entry and no legacy guards, so the deploy
# fails instead of leaving concurrent rebuilders in place.
set -uo pipefail

APP_DIR=${APP_DIR:-/home/ubuntu}
SWAP_FILE=${SWAP_FILE:-/swapfile}
SWAP_SIZE=${SWAP_SIZE:-2G}
GUARD_SCRIPT="$APP_DIR/scripts/vertical-guard.sh"
GUARD_CRON="*/5 * * * * /usr/bin/flock -n $APP_DIR/.vertical-guard.cron.lock /bin/bash $GUARD_SCRIPT >/dev/null 2>&1"

log() { echo "[bootstrap] $*"; }

if sudo -n true 2>/dev/null; then
  SUDO="sudo -n"
else
  SUDO=""
  log "no passwordless sudo: skipping swap + journald setup"
fi

# ── swap ────────────────────────────────────────────────────────────────────
# Converge on $SWAP_FILE itself (present, >= $SWAP_SIZE, active), regardless
# of any other swap device the host may have.
swap_active() { swapon --show=NAME --noheadings 2>/dev/null | grep -qFx "$SWAP_FILE"; }
make_swapfile() {
  if swap_active && ! $SUDO swapoff "$SWAP_FILE"; then return 1; fi
  $SUDO rm -f "$SWAP_FILE"
  $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE" \
    && $SUDO chmod 600 "$SWAP_FILE" \
    && $SUDO mkswap "$SWAP_FILE" >/dev/null
}
if [ -n "$SUDO" ]; then
  WANT_BYTES=$(numfmt --from=iec "$SWAP_SIZE")
  HAVE_BYTES=$($SUDO stat -c %s "$SWAP_FILE" 2>/dev/null || echo 0)
  if [ "$HAVE_BYTES" -lt "$WANT_BYTES" ]; then
    log "creating $SWAP_SIZE swapfile at $SWAP_FILE (had ${HAVE_BYTES}B)"
    make_swapfile || log "warning: swapfile creation failed"
  fi
  if ! swap_active && [ -f "$SWAP_FILE" ]; then
    if ! $SUDO swapon "$SWAP_FILE" 2>/dev/null; then
      log "$SWAP_FILE is not a valid swapfile, recreating"
      make_swapfile && $SUDO swapon "$SWAP_FILE" || log "warning: swapon failed"
    fi
    swap_active && log "swap enabled"
  fi
  if swap_active && ! grep -qE "^$SWAP_FILE\s" /etc/fstab; then
    echo "$SWAP_FILE none swap sw 0 0" | $SUDO tee -a /etc/fstab >/dev/null && log "swap added to fstab"
  fi
  if [ "$(cat /proc/sys/vm/swappiness)" != 10 ]; then
    echo 'vm.swappiness=10' | $SUDO tee /etc/sysctl.d/99-swap.conf >/dev/null
    $SUDO sysctl -q vm.swappiness=10 && log "swappiness set to 10"
  fi
fi

# ── journald ────────────────────────────────────────────────────────────────
if [ -n "$SUDO" ]; then
  CONF=/etc/systemd/journald.conf.d/persistent.conf
  WANT=$'[Journal]\nStorage=persistent\nSystemMaxUse=200M'
  if [ "$(cat $CONF 2>/dev/null)" != "$WANT" ]; then
    $SUDO mkdir -p "$(dirname $CONF)"
    printf '%s\n' "$WANT" | $SUDO tee "$CONF" >/dev/null
    $SUDO mkdir -p /var/log/journal
    $SUDO systemctl restart systemd-journald && log "journald set to persistent (200M cap)"
  fi
fi

# ── ops-notify dependencies ─────────────────────────────────────────────────
# Alerts are best-effort, so a gap here is a warning rather than a failed
# deploy; install what we can and make the rest visible in the deploy log.
have_boto3() { python3 -c 'import boto3' >/dev/null 2>&1; }
if ! have_boto3; then
  if [ -n "$SUDO" ]; then
    log "installing python3-boto3 for scripts/ops-notify.sh"
    $SUDO apt-get install -y -qq python3 python3-boto3 >/dev/null 2>&1 || true
  fi
  if have_boto3; then log "boto3 installed"; else log "warning: python3/boto3 missing; ops-notify.sh alerts will not be delivered"; fi
fi
# Resolve credentials the same way ops-notify.sh will (instance role or any
# other boto3 provider); GetCallerIdentity needs no IAM permission.
if have_boto3 && ! timeout 15 python3 -c 'import boto3; boto3.client("sts", region_name="us-east-2").get_caller_identity()' >/dev/null 2>&1; then
  log "warning: no AWS credentials resolvable (instance IAM role missing?); ops-notify.sh alerts will not be delivered"
fi

# ── guard cron (mandatory) ──────────────────────────────────────────────────
[ -f "$GUARD_SCRIPT" ] || { log "error: $GUARD_SCRIPT missing"; exit 1; }
chmod +x "$GUARD_SCRIPT" 2>/dev/null || true
# Legacy per-vertical guards (hcf/qbe/suncorp/insignia/hub24/cfs): any
# *-guard.sh cron line that is not our own vertical-guard.sh.
legacy_lines() { grep -E '/[a-z0-9]+-guard\.sh( |$)' | grep -vF "$GUARD_SCRIPT" || true; }
CURRENT=$(crontab -l 2>/dev/null || true)
KEPT=$(printf '%s\n' "$CURRENT" | grep -vE '/[a-z0-9]+-guard\.sh( |$)' || true)
NEW=$(printf '%s\n%s\n' "$KEPT" "$GUARD_CRON" | sed '/^$/d')
if [ "$NEW" != "$(printf '%s\n' "$CURRENT" | sed '/^$/d')" ]; then
  printf '%s\n' "$NEW" | crontab - || { log "error: crontab install failed"; exit 1; }
  log "crontab updated: single vertical-guard entry"
fi

# Verify from cron's own view of the table, not from what we think we wrote.
INSTALLED=$(crontab -l 2>/dev/null || true)
LEGACY=$(printf '%s\n' "$INSTALLED" | legacy_lines | grep -c . || true)
GUARDS=$(printf '%s\n' "$INSTALLED" | grep -cF "$GUARD_SCRIPT" || true)
if [ "$LEGACY" != 0 ] || [ "$GUARDS" != 1 ]; then
  log "error: crontab not converged (legacy guards=$LEGACY, vertical-guard entries=$GUARDS)"
  exit 1
fi

exit 0
