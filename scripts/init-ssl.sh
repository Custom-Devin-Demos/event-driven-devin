#!/usr/bin/env bash
# =============================================================================
# init-ssl.sh — One-time SSL certificate provisioning for Acme Commerce
#
# Prerequisites:
#   - Domain DNS A record pointing to this server's public IP
#   - Ports 80 and 443 open in the security group / firewall
#   - DOMAIN_NAME and CERT_EMAIL set in .env
#
# Usage:
#   cd /home/ubuntu   # (or wherever docker-compose.yml lives)
#   bash scripts/init-ssl.sh
#
# What it does:
#   1. Reads DOMAIN_NAME and CERT_EMAIL from .env
#   2. Starts nginx with HTTP-only config (nginx-init.conf)
#   3. Runs certbot to obtain a Let's Encrypt certificate
#   4. Restarts the full stack with SSL-enabled nginx.conf
#
# After running this once, certificate renewal is automatic via the
# certbot service defined in docker-compose.yml.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Load .env ────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in DOMAIN_NAME + CERT_EMAIL."
  exit 1
fi

# Source .env (handles lines with export prefix and comments)
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${DOMAIN_NAME:-}" ]; then
  echo "ERROR: DOMAIN_NAME is not set in .env"
  exit 1
fi

if [ -z "${CERT_EMAIL:-}" ]; then
  echo "ERROR: CERT_EMAIL is not set in .env"
  exit 1
fi

echo ""
echo "=== Acme Commerce — SSL Certificate Setup ==="
echo "  Domain: ${DOMAIN_NAME}"
echo "  Email:  ${CERT_EMAIL}"
echo ""

# ── Check if certs already exist ─────────────────────────────────────────────
CERT_DIR="./certbot/conf/live/${DOMAIN_NAME}"
if [ -d "$CERT_DIR" ] && [ -f "$CERT_DIR/fullchain.pem" ]; then
  echo "Certificates already exist at ${CERT_DIR}."
  echo "To force renewal, run: docker compose run --rm certbot renew --force-renewal"
  echo ""
  echo "Starting full stack with SSL..."
  docker compose down 2>/dev/null || true
  docker compose up -d --build
  echo "Done! Site available at https://${DOMAIN_NAME}"
  exit 0
fi

# ── Step 1: Create certbot directories ───────────────────────────────────────
echo "Step 1/4: Creating certbot directories..."
mkdir -p ./certbot/conf
mkdir -p ./certbot/www

# ── Step 2: Start nginx with HTTP-only config ────────────────────────────────
echo "Step 2/4: Starting nginx with HTTP-only config for ACME challenge..."
docker compose down 2>/dev/null || true

# Start only checkout-api and nginx (with init config)
# We override the nginx config via the NGINX_CONF env var
NGINX_CONF=./nginx/nginx-init.conf docker compose up -d checkout-api nginx

# Wait for nginx to be ready
echo "  Waiting for nginx to start..."
sleep 5

# Verify nginx is responding
if ! curl -sf http://localhost/.well-known/acme-challenge/ > /dev/null 2>&1; then
  echo "  Warning: nginx may not be fully ready yet, proceeding anyway..."
fi

# ── Step 3: Obtain certificate via certbot ───────────────────────────────────
echo "Step 3/4: Requesting certificate from Let's Encrypt..."
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "${CERT_EMAIL}" \
  --agree-tos \
  --no-eff-email \
  -d "${DOMAIN_NAME}"

# Verify certificate was obtained
if [ ! -f "./certbot/conf/live/${DOMAIN_NAME}/fullchain.pem" ]; then
  echo ""
  echo "ERROR: Certificate was not obtained. Common causes:"
  echo "  - DNS A record not pointing to this server"
  echo "  - Port 80 not open in security group / firewall"
  echo "  - Domain name typo"
  echo ""
  echo "Check the certbot output above for details."
  docker compose down 2>/dev/null || true
  exit 1
fi

echo "  Certificate obtained successfully!"

# ── Step 4: Restart with full SSL config ─────────────────────────────────────
echo "Step 4/4: Restarting with full SSL configuration..."
docker compose down
docker compose up -d --build

echo ""
echo "=== SSL Setup Complete! ==="
echo ""
echo "  Your site is now available at:"
echo "    https://${DOMAIN_NAME}"
echo ""
echo "  Certificate renewal is automatic (certbot runs every 12 hours)."
echo "  To manually renew: docker compose run --rm certbot renew"
echo ""
echo "  Next steps:"
echo "    1. Verify https://${DOMAIN_NAME} loads correctly"
echo "    2. Update Sentry webhook URL to https://${DOMAIN_NAME}/webhooks/sentry"
echo "    3. Close port 3000 in the EC2 security group (no longer needed)"
echo ""
