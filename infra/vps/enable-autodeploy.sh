#!/bin/bash
# Turns on deploy-on-push: every two minutes this server checks the GitHub branch and deploys a
# new commit (see autodeploy.sh). Run as root on the VPS, after setup.sh, next to autodeploy.sh:
#   bash enable-autodeploy.sh https://github.com/OWNER/REPO [branch]
# A private repository needs a read-only deploy key; this prints it and waits until it works.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
URL="${1:?Usage: bash enable-autodeploy.sh https://github.com/OWNER/REPO [branch]}"
BRANCH="${2:-main}"
[[ -f "$HERE/autodeploy.sh" && -f "$HERE/autodeploy-webhook.py" ]] || { echo "autodeploy.sh and autodeploy-webhook.py must sit next to this script."; exit 1; }
[[ -f /srv/rakazo/.env ]] || { echo "Run setup.sh first."; exit 1; }

# owner/repo from https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
if [[ "$URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?/?$ ]]; then
  OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"
else
  echo "Give a GitHub repository URL, e.g. https://github.com/owner/repo"; exit 1
fi

REPO_URL="https://github.com/$OWNER/$REPO.git"
if ! GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
  # Private: read it over SSH with a key that can only read this repository.
  KEY=/root/.ssh/rakazo_deploy
  [[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "rakazo-autodeploy" -f "$KEY"
  mkdir -p /root/.ssh && touch /root/.ssh/config
  grep -q "Host github-rakazo-deploy" /root/.ssh/config || cat >>/root/.ssh/config <<EOF
Host github-rakazo-deploy
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  ssh-keyscan -q github.com >>/root/.ssh/known_hosts 2>/dev/null
  REPO_URL="git@github-rakazo-deploy:$OWNER/$REPO.git"
  echo
  echo "This repository is private. Add this key on GitHub:"
  echo "  $URL/settings/keys  ->  Add deploy key  (leave 'Allow write access' OFF)"
  echo
  cat "$KEY.pub"
  echo
  echo "Waiting for the key to work (Ctrl+C to stop)..."
  until git ls-remote --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; do sleep 5; done
  echo "Key works."
fi
git ls-remote --heads "$REPO_URL" "$BRANCH" | grep -q . || { echo "Branch '$BRANCH' not found."; exit 1; }

install -d -m 0755 /etc/rakazo
printf 'REPO_URL=%s\nBRANCH=%s\n' "$REPO_URL" "$BRANCH" >/etc/rakazo/autodeploy.env
[[ -f "$HERE/bot-desktop.patch" ]] && install -m 0644 "$HERE/bot-desktop.patch" /etc/rakazo/bot-desktop.patch
install -m 0755 "$HERE/autodeploy.sh" /usr/local/sbin/rakazo-autodeploy

cat >/etc/systemd/system/rakazo-autodeploy.service <<'EOF'
[Unit]
Description=Deploy the newest Rakazo commit from GitHub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rakazo-autodeploy
TimeoutStartSec=2h
EOF
cat >/etc/systemd/system/rakazo-autodeploy.timer <<'EOF'
[Unit]
Description=Check GitHub for a new Rakazo commit every two minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Persistent=true

[Install]
WantedBy=timers.target
EOF
# GitHub webhook: a push to the branch starts a deploy at once. The listener runs unprivileged and
# can only rewrite the trigger file; the path unit turns that into a deploy run.
id rakazo-hook >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin rakazo-hook
install -d -o rakazo-hook -g rakazo-hook -m 0750 /var/lib/rakazo-hook
[[ -f /var/lib/rakazo-hook/trigger ]] || install -o rakazo-hook -g rakazo-hook -m 0640 /dev/null /var/lib/rakazo-hook/trigger
if [[ ! -s /etc/rakazo/webhook-secret ]]; then
  openssl rand -hex 32 >/etc/rakazo/webhook-secret
fi
chown root:rakazo-hook /etc/rakazo/webhook-secret
chmod 0640 /etc/rakazo/webhook-secret
install -d /usr/local/lib/rakazo
install -m 0755 "$HERE/autodeploy-webhook.py" /usr/local/lib/rakazo/autodeploy-webhook.py

cat >/etc/systemd/system/rakazo-autodeploy-webhook.service <<EOF
[Unit]
Description=GitHub push webhook for Rakazo deploys
After=network.target

[Service]
User=rakazo-hook
Group=rakazo-hook
Environment=WEBHOOK_SECRET_FILE=/etc/rakazo/webhook-secret
Environment=TRIGGER_FILE=/var/lib/rakazo-hook/trigger
Environment=BRANCH=$BRANCH
Environment=PORT=9002
ExecStart=/usr/bin/python3 /usr/local/lib/rakazo/autodeploy-webhook.py
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/rakazo-hook
CapabilityBoundingSet=
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/rakazo-autodeploy.path <<'EOF'
[Unit]
Description=Start a Rakazo deploy when the GitHub webhook fires

[Path]
PathChanged=/var/lib/rakazo-hook/trigger
Unit=rakazo-autodeploy.service

[Install]
WantedBy=paths.target
EOF

# Caddy forwards only the webhook path to the listener; everything else still goes to Rakazo.
mkdir -p /etc/caddy/rakazo.d
cat >/etc/caddy/rakazo.d/autodeploy.caddy <<'EOF'
handle /_autodeploy/github {
	reverse_proxy 127.0.0.1:9002
}
EOF
if ! grep -q 'import /etc/caddy/rakazo.d/' /etc/caddy/Caddyfile; then
  sed -i '0,/{$/s//{\n\timport \/etc\/caddy\/rakazo.d\/*.caddy/' /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "Caddy config is invalid; not reloading."; exit 1; }
systemctl reload caddy

systemctl daemon-reload
systemctl enable --now rakazo-autodeploy.timer rakazo-autodeploy.path rakazo-autodeploy-webhook.service >/dev/null
DOMAIN="$(grep '^RAKAZO_HOST=' /srv/rakazo/.env | cut -d= -f2-)"
cat <<EOF

Deploy-on-push is on for $OWNER/$REPO ($BRANCH).

Add the webhook on GitHub:  $URL/settings/hooks  ->  Add webhook
  Payload URL:    https://$DOMAIN/_autodeploy/github
  Content type:   application/json
  Secret:         $(cat /etc/rakazo/webhook-secret)
  Events:         Just the push event

A push to $BRANCH then deploys at once (a check every two minutes covers a missed webhook).
The first deploy builds for about 20-30 minutes.
Follow it:  journalctl -fu rakazo-autodeploy      Status:  rakazo-autodeploy status
EOF
