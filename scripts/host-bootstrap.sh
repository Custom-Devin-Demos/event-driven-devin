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
#
# Everything privileged goes through `sudo -n`; when passwordless sudo is not
# available the step is logged and skipped rather than failing the deploy.
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
if [ -n "$SUDO" ]; then
  if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
    if [ ! -f "$SWAP_FILE" ]; then
      log "creating $SWAP_SIZE swapfile at $SWAP_FILE"
      $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE" \
        && $SUDO chmod 600 "$SWAP_FILE" \
        && $SUDO mkswap "$SWAP_FILE" >/dev/null \
        || log "warning: swapfile creation failed"
    fi
    [ -f "$SWAP_FILE" ] && { $SUDO swapon "$SWAP_FILE" && log "swap enabled" || log "warning: swapon failed"; }
  fi
  if [ -f "$SWAP_FILE" ] && ! grep -qE "^$SWAP_FILE\s" /etc/fstab; then
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

# ── guard cron ──────────────────────────────────────────────────────────────
if [ -x "$GUARD_SCRIPT" ] || [ -f "$GUARD_SCRIPT" ]; then
  chmod +x "$GUARD_SCRIPT" 2>/dev/null || true
  CURRENT=$(crontab -l 2>/dev/null || true)
  # Drop the legacy per-vertical guards (hcf/qbe/suncorp/insignia/hub24/cfs).
  KEPT=$(printf '%s\n' "$CURRENT" | grep -vE '/[a-z0-9]+-guard\.sh( |$)' | grep -v "$GUARD_SCRIPT" || true)
  NEW=$(printf '%s\n%s\n' "$KEPT" "$GUARD_CRON" | sed '/^$/d')
  if [ "$NEW" != "$(printf '%s\n' "$CURRENT" | sed '/^$/d')" ]; then
    printf '%s\n' "$NEW" | crontab - && log "crontab updated: single vertical-guard entry"
  fi
else
  log "warning: $GUARD_SCRIPT missing, crontab left untouched"
fi

exit 0
