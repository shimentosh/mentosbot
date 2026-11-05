/**
 * The setup script a deployment admin runs on a new server so it can run bots' computers. It
 * holds no secret: the token arrives as an argument and stays in a root-only file. The supervisor
 * listens only on the private address given, beside the screens it publishes there.
 */
export const COMPUTER_SERVER_INSTALL_PATH = "/api/computer-servers/install.sh";

export const COMPUTER_SERVER_INSTALL_SCRIPT = `#!/usr/bin/env bash
# Sets up a server that runs Rakazo bots' computers for another Rakazo server.
# Usage: install.sh --token TOKEN --address PRIVATE_IP [--image IMAGE] [--computer-image IMAGE]
set -euo pipefail

TOKEN=""
ADDRESS=""
IMAGE="\${RAKAZO_IMAGE:-ghcr.io/elie222/rakazo/app:edge}"
COMPUTER_IMAGE="\${RAKAZO_COMPUTER_IMAGE:-ghcr.io/elie222/rakazo/computer:edge}"
DIR=/srv/rakazo-computer-server
NAME=rakazo-computer-server

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --address) ADDRESS="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --computer-image) COMPUTER_IMAGE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TOKEN" ] || [ -z "$ADDRESS" ]; then
  echo "Usage: install.sh --token TOKEN --address PRIVATE_IP" >&2
  exit 2
fi
if [ "$(id -u)" != 0 ]; then
  echo "Run this as root (sudo)." >&2
  exit 1
fi
if ! ip -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qxF "$ADDRESS"; then
  echo "$ADDRESS is not an address of this server. Use its private network address." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
fi
systemctl enable --now docker >/dev/null 2>&1 || true

install -d -m 700 "$DIR"
install -d -o 1000 -g 1000 -m 755 "$DIR/data" "$DIR/data/homes"
umask 077
cat > "$DIR/supervisor.env" <<ENV
NODE_ENV=production
DATA_DIR=$DIR/data
SUPERVISOR_HOST=$ADDRESS
SUPERVISOR_PORT=7091
DOCKER_SOCKET=/var/run/docker.sock
RAKAZO_COMPUTER_IMAGE=$COMPUTER_IMAGE
SANDBOX_SUPERVISOR_TOKEN=$TOKEN
SANDBOX_SCREEN_NETWORK=published
SANDBOX_SCREEN_HOST=$ADDRESS
SANDBOX_SCREEN_BIND=$ADDRESS
ENV

docker pull "$IMAGE"
docker pull "$COMPUTER_IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# Host networking lets the supervisor reach each computer's own network directly, and the data
# directory keeps the same path inside and out so computers mount homes the supervisor names.
docker run -d --name "$NAME" --restart unless-stopped --init \\
  --network host \\
  --user 1000:1000 --group-add "$(stat -c %g /var/run/docker.sock)" \\
  --security-opt no-new-privileges:true \\
  --env-file "$DIR/supervisor.env" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$DIR/data:$DIR/data" \\
  "$IMAGE" pnpm --filter @rakazo/sandbox-supervisor start >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://$ADDRESS:7091/health" >/dev/null 2>&1; then
    echo "Ready. Rakazo will start using this server within a few seconds."
    exit 0
  fi
  sleep 2
done
echo "The supervisor didn't start. See: docker logs $NAME" >&2
exit 1
`;
