#!/bin/bash
# Builds Rakazo's bot computer image with this deployment's desktop (bot-desktop.patch):
# Debian 13, Google Chrome, and an Xfce panel on every bot's display. Then points this
# Rakazo install at it. Run as root on the VPS, next to bot-desktop.patch:
#   bash custom-computer.sh
# Existing bot computers switch over on 'Update computer'; their files are kept.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC=/srv/rakazo-src
RAKAZO_DIR=/srv/rakazo
IMAGE=rakazo-custom/computer
TAG=desktop

[ "$(dpkg --print-architecture)" = amd64 ] || { echo "Google Chrome needs an amd64 server."; exit 1; }
[ -f "$HERE/bot-desktop.patch" ] || { echo "bot-desktop.patch must sit next to this script."; exit 1; }

echo "==> Rakazo source"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q --depth 1 origin main && git -C "$SRC" reset -q --hard origin/main
else
  git clone -q --depth 1 https://github.com/elie222/rakazo.git "$SRC"
fi

echo "==> Apply bot-desktop.patch"
if ! git -C "$SRC" apply --3way --whitespace=nowarn "$HERE/bot-desktop.patch"; then
  echo "The patch no longer applies to the latest Rakazo; update bot-desktop.patch." >&2
  exit 1
fi

echo "==> Build $IMAGE:$TAG (several minutes)"
docker build -q -t "$IMAGE:$TAG" "$SRC/infra/sandboxes/computer" >/dev/null
docker run --rm --entrypoint sh "$IMAGE:$TAG" -c \
  'grep PRETTY /etc/os-release; google-chrome --version; command -v xfwm4 xfce4-panel thunar xfce4-terminal >/dev/null && echo "Xfce desktop: installed"' 2>/dev/null

echo "==> Use it"
cd "$RAKAZO_DIR"
setv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
setv RAKAZO_COMPUTER_IMAGE "$IMAGE"
setv RAKAZO_COMPUTER_IMAGE_TAG "$TAG"
docker compose -f docker-compose.images.yml --env-file .env up -d --wait --pull never >/dev/null
echo "Done. Existing bot computers switch over after 'Update computer'."
