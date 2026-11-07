#!/bin/bash
# Rakazo self-host setup for a fresh Debian 12/13 or Ubuntu 22.04/24.04 VPS.
# Run as root on the VPS:
#   DOMAIN=rakazo.example.com bash setup.sh            # full setup
#   bash setup.sh --lock-signups                       # after you created your account
# Safe to re-run: every step checks before changing anything.
set -euo pipefail

RAKAZO_DIR=/srv/rakazo
COMPOSE="docker compose -f $RAKAZO_DIR/docker-compose.images.yml --env-file $RAKAZO_DIR/.env"

if [ "${1:-}" = "--lock-signups" ]; then
  sed -i 's/^SIGNUPS_ENABLED=.*/SIGNUPS_ENABLED=false/' "$RAKAZO_DIR/.env"
  $COMPOSE up -d --wait api worker >/dev/null
  echo "Signups are now closed."
  exit 0
fi

: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=rakazo.example.com bash setup.sh}"
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ -s /root/.ssh/authorized_keys ] || { echo "Add your SSH key to /root/.ssh/authorized_keys first."; exit 1; }
. /etc/os-release
DISTRO=$ID   # debian or ubuntu
export DEBIAN_FRONTEND=noninteractive
step() { echo; echo "==> $*"; }

step "System packages"
apt-get update -qq
apt-get -y -qq upgrade >/dev/null
apt-get install -y -qq ca-certificates curl gnupg git openssl ufw fail2ban tmux \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

step "Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$DISTRO $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1

step "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
mkdir -p /etc/caddy/rakazo.d
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	import /etc/caddy/rakazo.d/*.caddy
	encode zstd gzip
	reverse_proxy 127.0.0.1:5173
}
EOF
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy

step "Google Chrome"
if ! command -v google-chrome >/dev/null && [ "$(dpkg --print-architecture)" = amd64 ]; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --batch --yes --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq && apt-get install -y -qq google-chrome-stable >/dev/null
fi

step "Swap (4 GB)"
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null 2>&1

step "Rakazo"
mkdir -p "$RAKAZO_DIR" && cd "$RAKAZO_DIR"
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh
[ -f .env ] || bash install-images.sh --prepare-only >/dev/null
sed -i \
  -e "s#^BETTER_AUTH_URL=.*#BETTER_AUTH_URL=https://$DOMAIN#" \
  -e "s#^WEB_ORIGIN=.*#WEB_ORIGIN=https://$DOMAIN#" \
  -e "s#^API_URL=.*#API_URL=https://$DOMAIN#" \
  -e "s#^RAKAZO_HOST=.*#RAKAZO_HOST=$DOMAIN#" .env
# Room for several bots on one Team Computer (each runs its own browser).
grep -q '^RAKAZO_COMPUTER_MEMORY=' .env || echo 'RAKAZO_COMPUTER_MEMORY=4g' >> .env
# Settings → Computer and Settings → Storage are for these accounts (once their email is verified).
if [ -n "${ADMIN_EMAIL:-}" ]; then
  if grep -q '^RAKAZO_ADMIN_EMAILS=' .env; then sed -i "s#^RAKAZO_ADMIN_EMAILS=.*#RAKAZO_ADMIN_EMAILS=$ADMIN_EMAIL#" .env; else echo "RAKAZO_ADMIN_EMAILS=$ADMIN_EMAIL" >> .env; fi
fi
chmod 600 .env
if grep -q '^RAKAZO_COMPUTER_IMAGE=rakazo-custom/' .env; then
  # The custom computer image is local, so install-images.sh would fail to pull it.
  docker compose -f docker-compose.images.yml --env-file .env pull --ignore-pull-failures -q >/dev/null 2>&1 || true
  docker compose -f docker-compose.images.yml --env-file .env up -d --wait --pull never >/dev/null
else
  bash install-images.sh 2>&1 | tail -1
fi

step "Claude Code (user 'claude')"
id claude >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo,docker claude
echo 'claude ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/claude && chmod 440 /etc/sudoers.d/claude
install -d -m 700 -o claude -g claude /home/claude/.ssh
install -m 600 -o claude -g claude /root/.ssh/authorized_keys /home/claude/.ssh/authorized_keys
[ -x /home/claude/.local/bin/claude ] || su - claude -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1
su - claude -c 'grep -q ".local/bin" ~/.bashrc || echo "export PATH=\$HOME/.local/bin:\$PATH" >> ~/.bashrc'

step "SSH: keys only"
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' \
  > /etc/ssh/sshd_config.d/10-keys-only.conf
sshd -t && systemctl reload ssh

step "Check"
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || true)
echo "https://$DOMAIN -> HTTP $code"
echo "Claude Code: $(su - claude -c '~/.local/bin/claude --version' 2>/dev/null || echo missing)"
$COMPOSE ps --format '{{.Service}}: {{.Status}}'
echo
echo "Done. Next: sign up at https://$DOMAIN, then run: bash setup.sh --lock-signups"
echo "Back up ENCRYPTION_KEY from $RAKAZO_DIR/.env somewhere safe."
