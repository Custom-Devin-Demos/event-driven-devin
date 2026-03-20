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

# Generate a temporary HTTP-only nginx config with DOMAIN_NAME substituted.
# We write it directly and mount it as a plain config file (not a template),
# avoiding the nginx:alpine entrypoint template-processing requirement.
INIT_CONF="nginx/nginx-init-rendered.conf"
sed "s/\${DOMAIN_NAME}/${DOMAIN_NAME}/g" ./nginx/nginx-init.conf > "$INIT_CONF"
echo "  Generated temporary config: $INIT_CONF"

# Start nginx with the rendered init config mounted directly into conf.d.
# We must also override the entrypoint to skip the default nginx:alpine
# template-processing step, which would try to overwrite our config file
# with envsubst output from the SSL template (docker compose merges volumes
# from all -f files, so the template mount from docker-compose.yml is still
# present even with this override).
docker compose -f docker-compose.yml -f - up -d checkout-api nginx <<EOF
services:
  nginx:
    entrypoint: [""]
    command: ["nginx", "-g", "daemon off;"]
    volumes:
      - ./${INIT_CONF}:/etc/nginx/conf.d/default.conf:ro
      - ./certbot/conf:/etc/letsencrypt:ro
      - ./certbot/www:/var/www/certbot:ro
EOF

# Wait for nginx to be ready
echo "  Waiting for nginx to start..."
for i in $(seq 1 15); do
  if curl -sf http://localhost/ > /dev/null 2>&1; then
    echo "  nginx is ready!"
    break
  fi
  sleep 2
done

# Verify nginx is serving correctly
if ! curl -sf http://localhost/ > /dev/null 2>&1; then
  echo "  Warning: nginx may not be fully ready yet, proceeding anyway..."
fi

# ── Step 3: Obtain certificate via certbot ───────────────────────────────────
echo "Step 3/4: Requesting certificate from Let's Encrypt..."
# Override the entrypoint because docker-compose.yml sets it to the
# renewal loop script; without this, "certonly" is passed as args to
# that loop and certbot never actually runs.
docker compose run --rm --no-deps --entrypoint certbot certbot certonly \
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

# Clean up temporary init config
rm -f "$INIT_CONF"

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
