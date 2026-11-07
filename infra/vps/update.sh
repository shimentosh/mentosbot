#!/bin/bash
# Update Rakazo to the latest published images, keeping the custom
# Debian 13 + Google Chrome bot computer. Run as root on the VPS:
#   bash update.sh
# (Rakazo's own install-images.sh would try to pull the custom computer image
# from the registry and fail, so use this instead once custom-computer.sh ran.)
set -euo pipefail
cd /srv/rakazo
COMPOSE="docker compose -f docker-compose.images.yml --env-file .env"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> Pull published images (the custom computer image is skipped)"
$COMPOSE pull --ignore-pull-failures -q 2>&1 | grep -v "rakazo-custom" || true

if grep -q '^RAKAZO_COMPUTER_IMAGE=rakazo-custom/' .env; then
  echo "==> Rebuild the Debian 13 + Chrome computer from the latest Rakazo source"
  bash "$HERE/custom-computer.sh"
fi

echo "==> Restart"
$COMPOSE up -d --wait --pull never >/dev/null
$COMPOSE ps --format '{{.Service}}: {{.Status}}'
echo "Done. Bot computers pick up a new computer image after 'Update computer'."
