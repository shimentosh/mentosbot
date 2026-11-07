#!/bin/bash
# From the Mac: set up a fresh Debian 13 VPS end to end and turn on deploy-on-push.
#   bash infra/vps/new-vps.sh <IP> <domain> <github-repo-url> [branch] [admin-email]
# The droplet must have been created with the rakazo-vps SSH key, and the domain's DNS
# (DNS only / grey cloud) must already point at the IP.
set -euo pipefail
IP="${1:?IP}"; DOMAIN="${2:?domain}"; REPO="${3:?GitHub repo URL}"; BRANCH="${4:-main}"; ADMIN="${5:-}"
KIT="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -i ~/.ssh/rakazo_vps -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

ssh-keygen -R "$IP" >/dev/null 2>&1 || true
echo "==> Connecting to $IP"
"${SSH[@]}" -o BatchMode=yes "root@$IP" 'grep PRETTY /etc/os-release' \
  || { echo "Cannot log in. Add the rakazo-vps key: ssh-copy-id -i ~/.ssh/rakazo_vps.pub root@$IP"; exit 1; }
echo "==> DNS: $DOMAIN -> $(dig +short "$DOMAIN" | tail -1)"

echo "==> Copying the setup kit"
scp -q -i ~/.ssh/rakazo_vps "$KIT"/{setup.sh,autodeploy.sh,autodeploy-webhook.py,enable-autodeploy.sh,bot-desktop.patch,custom-computer.sh,update.sh,test-desktop.sh,use-r2.sh} "root@$IP:"

echo "==> Server setup (Docker, HTTPS, firewall, Rakazo, Claude Code) — about 10 minutes"
"${SSH[@]}" "root@$IP" "DOMAIN='$DOMAIN' ADMIN_EMAIL='$ADMIN' bash setup.sh"

# A webhook secret made ahead of time (so GitHub could be set up first) is installed as is;
# enable-autodeploy.sh keeps an existing secret. It lives outside the repository.
SECRET_FILE="$HOME/.rakazo-vps/webhook-secret-$DOMAIN"
if [[ -s "$SECRET_FILE" ]]; then
  "${SSH[@]}" "root@$IP" 'install -d -m 0755 /etc/rakazo; umask 077; cat > /etc/rakazo/webhook-secret' <"$SECRET_FILE"
fi

echo "==> Deploy-on-push from $REPO ($BRANCH)"
"${SSH[@]}" -t "root@$IP" "bash enable-autodeploy.sh '$REPO' '$BRANCH'"

cat <<NEXT

Done. Next:
  1. Sign up at https://$DOMAIN, then close signups:
       ssh -i ~/.ssh/rakazo_vps root@$IP 'bash setup.sh --lock-signups'
  2. Watch the first deploy (20-30 min):  ssh -i ~/.ssh/rakazo_vps root@$IP 'journalctl -fu rakazo-autodeploy'
  3. Connect Claude: see README step 5.
NEXT
