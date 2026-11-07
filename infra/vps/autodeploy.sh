#!/bin/bash
# Deploys the newest commit on the tracked GitHub branch to this server.
#
# A systemd timer runs it every two minutes (see enable-autodeploy.sh). When the branch has a
# commit that is not deployed yet, it builds the app image and, when its folder changed, the bot
# computer image from that commit; switches Rakazo to them; and checks the site. If the new
# release does not come up healthy, it puts the previous images back and remembers the commit
# as failed, so a broken commit is not retried until a newer one arrives.
#
#   rakazo-autodeploy          deploy if there is something new (what the timer runs)
#   rakazo-autodeploy status   show what is deployed and the last result
set -Eeuo pipefail

CONF=/etc/rakazo/autodeploy.env
SRC=/srv/rakazo-deploy-src
RAKAZO_DIR=/srv/rakazo
STATE=/var/lib/rakazo-autodeploy
PATCH=/etc/rakazo/bot-desktop.patch
APP_IMAGE=rakazo-custom/app
COMPUTER_IMAGE=rakazo-custom/computer
MIN_FREE_GB=10

# shellcheck disable=SC1090
source "$CONF"
: "${REPO_URL:?REPO_URL missing from $CONF}"
BRANCH="${BRANCH:-main}"
mkdir -p "$STATE"
log() { echo "[$(date -u +%FT%TZ)] $*"; }

if [[ "${1:-}" == "status" ]]; then
  echo "repo:      $REPO_URL ($BRANCH)"
  echo "deployed:  $(cat "$STATE/deployed" 2>/dev/null || echo none)"
  echo "failed:    $(cat "$STATE/failed" 2>/dev/null || echo none)"
  echo "running:   $(grep -E '^RAKAZO_(IMAGE_TAG|COMPUTER_IMAGE_TAG)=' "$RAKAZO_DIR/.env" | tr '\n' ' ')"
  echo "last run:"
  journalctl -u rakazo-autodeploy --no-pager -n 15 -o cat 2>/dev/null || true
  exit 0
fi

# One deploy at a time; a run that finds one in progress leaves it alone.
exec 9>/run/rakazo-autodeploy.lock
flock -n 9 || exit 0

if [[ ! -d "$SRC/.git" ]]; then
  git clone -q --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
git -C "$SRC" remote set-url origin "$REPO_URL"
git -C "$SRC" fetch -q origin "$BRANCH"
sha="$(git -C "$SRC" rev-parse FETCH_HEAD)"
[[ "$sha" == "$(cat "$STATE/deployed" 2>/dev/null)" ]] && exit 0
[[ "$sha" == "$(cat "$STATE/failed" 2>/dev/null)" ]] && exit 0
short="${sha:0:12}"
log "deploying $short from $BRANCH"

free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
if (( free_gb < MIN_FREE_GB )); then
  docker image prune -f >/dev/null || true
  docker builder prune -f --keep-storage 8GB >/dev/null || true
  free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  (( free_gb >= MIN_FREE_GB )) || { log "only ${free_gb}GB free; not deploying"; exit 1; }
fi

git -C "$SRC" checkout -q --force "$sha"
git -C "$SRC" clean -qfdx

fail() {
  log "FAILED: $*"
  echo "$sha" >"$STATE/failed"
  exit 1
}

log "building app image"
timeout 60m docker build -q -f "$SRC/infra/compose/Dockerfile" --build-arg "GIT_SHA=$sha" \
  -t "$APP_IMAGE:$short" "$SRC" >/dev/null || fail "app image build"

# The computer image changes rarely; rebuild it only when its folder (or the desktop patch) did.
computer_tree="$(git -C "$SRC" rev-parse "$sha:infra/sandboxes/computer")"
patch_sum="$( [[ -f "$PATCH" ]] && sha256sum "$PATCH" | cut -c1-12 || echo none)"
computer_tag="${computer_tree:0:12}-$patch_sum"
if ! docker image inspect "$COMPUTER_IMAGE:$computer_tag" >/dev/null 2>&1; then
  # A repository that already carries the desktop needs no patch.
  if [[ -f "$PATCH" && ! -f "$SRC/infra/sandboxes/computer/rakazo-desktop-session" ]]; then
    git -C "$SRC" apply --3way --whitespace=nowarn "$PATCH" || fail "bot-desktop.patch does not apply"
  fi
  log "building bot computer image"
  timeout 40m docker build -q -t "$COMPUTER_IMAGE:$computer_tag" "$SRC/infra/sandboxes/computer" >/dev/null \
    || fail "computer image build"
  git -C "$SRC" checkout -q --force "$sha" && git -C "$SRC" clean -qfdx
fi

cd "$RAKAZO_DIR"
env_value() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
setv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >>.env; fi; }
previous_image="$(env_value RAKAZO_IMAGE)"
previous_tag="$(env_value RAKAZO_IMAGE_TAG)"
previous_computer="$(env_value RAKAZO_COMPUTER_IMAGE)"
previous_computer_tag="$(env_value RAKAZO_COMPUTER_IMAGE_TAG)"
cp -p .env "$STATE/env.before-$short"
# The compose file comes from the deployed commit too, so new services and settings arrive with it.
cp -p docker-compose.images.yml "$STATE/compose.before-$short"
git -C "$SRC" show "$sha:infra/compose/docker-compose.images.yml" >docker-compose.images.yml.new \
  && mv docker-compose.images.yml.new docker-compose.images.yml \
  || { rm -f docker-compose.images.yml.new; fail "no infra/compose/docker-compose.images.yml in $short"; }
COMPOSE=(docker compose -f docker-compose.images.yml --env-file .env)

healthy() {
  local host
  host="$(env_value RAKAZO_HOST)"
  for _ in $(seq 1 24); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "https://$host/")" == 200 ]] \
      && [[ "$(docker inspect -f '{{.State.Health.Status}}' rakazo-api-1 2>/dev/null)" == healthy ]] \
      && [[ "$(docker inspect -f '{{.State.Health.Status}}' rakazo-worker-1 2>/dev/null)" == healthy ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

log "switching to $short (computer $computer_tag)"
setv RAKAZO_IMAGE "$APP_IMAGE"
setv RAKAZO_IMAGE_TAG "$short"
setv RAKAZO_COMPUTER_IMAGE "$COMPUTER_IMAGE"
setv RAKAZO_COMPUTER_IMAGE_TAG "$computer_tag"
if timeout 15m "${COMPOSE[@]}" up -d --wait --wait-timeout 600 --pull never >/dev/null 2>&1 && healthy; then
  echo "$sha" >"$STATE/deployed"
  rm -f "$STATE/failed"
  # Keep the last few backups only.
  ls -1t "$STATE"/env.before-* 2>/dev/null | tail -n +6 | xargs -r rm -f
  ls -1t "$STATE"/compose.before-* 2>/dev/null | tail -n +6 | xargs -r rm -f
  log "deployed $short"
  # Keep the running and previous app images; drop older ones.
  docker images "$APP_IMAGE" --format '{{.Tag}}' | grep -vxF -e "$short" -e "$previous_tag" \
    | xargs -r -I{} docker rmi "$APP_IMAGE:{}" >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  # A push that arrived while this deploy ran found it busy; deploy that one now.
  newest="$(git -C "$SRC" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
  if [[ -n "$newest" && "$newest" != "$sha" ]]; then
    log "a newer commit arrived during the deploy; deploying it"
    exec "$0"
  fi
  exit 0
fi

log "new release unhealthy; restoring $previous_tag"
cp -p "$STATE/compose.before-$short" docker-compose.images.yml
setv RAKAZO_IMAGE "$previous_image"
setv RAKAZO_IMAGE_TAG "$previous_tag"
setv RAKAZO_COMPUTER_IMAGE "$previous_computer"
setv RAKAZO_COMPUTER_IMAGE_TAG "$previous_computer_tag"
timeout 15m "${COMPOSE[@]}" up -d --wait --wait-timeout 600 --pull never >/dev/null 2>&1 || true
healthy && log "previous release restored" || log "previous release is not healthy either; check the server"
fail "release $short did not come up healthy"
