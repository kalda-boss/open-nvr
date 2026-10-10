#!/usr/bin/env bash
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Deploy this fork's core to the stack running from THIS checkout.
#
#   scripts/deploy.sh                 # deploy origin/main
#   scripts/deploy.sh --ref <commit>  # deploy a specific commit/branch
#   scripts/deploy.sh --yes           # no confirmation prompt
#
# Run it from the checkout the live stack runs from (the one with .env).
# In order, and stopping at the first failure:
#
#   1. Resolve the target commit; refuse anything that isn't a
#      fast-forward of what's checked out.
#   2. Build ghcr.io/kalda-boss/open-nvr-core:<sha> from the COMMITTED
#      tree (git archive | docker build). The checkout is not touched yet:
#      MediaMTX hot-reloads its bind-mounted config and nginx reads its
#      own, so updating files before the image exists could leave the
#      stack half-new if the build then failed.
#   3. pg_dump the database to $OPENNVR_BACKUP_DIR (~/opennvr-backups).
#   4. Fast-forward the checkout, set FORK_CORE_TAG=<sha> in .env, and run
#      ./start.sh up — the launcher, not a bare `compose up`, so the host
#      IPs it detects reach the containers exactly as on a normal start.
#   5. Wait for core to report healthy on the new image.
#
# If step 4 or 5 fails it rolls back: previous commit and FORK_CORE_TAG,
# the database restored from the step-3 dump if a migration ran (anything
# written in the minutes between is lost), and ./start.sh up again.
#
# Recordings are written by MediaMTX, which only restarts if the update
# changed its own configuration.

set -Eeuo pipefail

cd "$(dirname "$0")/.."

IMAGE_REPO="ghcr.io/kalda-boss/open-nvr-core"   # keep in sync with docker-compose.yml
CORE_CONTAINER="opennvr_core"
DB_CONTAINER="opennvr_db"
BACKUP_DIR="${OPENNVR_BACKUP_DIR:-$HOME/opennvr-backups}"
BACKUPS_TO_KEEP=10
HEALTH_TIMEOUT_S=300

REF="origin/main"
ASSUME_YES=0
FETCH=1

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; GRAY='\033[0;90m'; NC='\033[0m'
say()  { echo -e "  $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

# Build and launcher output goes here; its tail is shown when a step fails.
LOG=$(mktemp -t opennvr-deploy.XXXXXX)
show_log() { echo -e "  ${GRAY}── last lines of $LOG ──${NC}" >&2; tail -25 "$LOG" | sed 's/^/      /' >&2; }

usage() { sed -n '5,9p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --no-fetch) FETCH=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

# Docker Desktop on macOS keeps its CLI helpers (docker-credential-desktop,
# which every build needs) in the app bundle, not always on PATH.
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
    PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "Docker isn't running"

[ -f .env ] || die "no .env here — run this from the checkout the live stack runs from"
[ -x ./start.sh ] || die "./start.sh not found"

# .env helpers (sed -i.bak works with both BSD and GNU sed).
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
env_set() {
    if grep -qE "^$1=" .env; then
        sed -i.bak -E "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}
env_unset() { sed -i.bak -E "/^$1=/d" .env && rm -f .env.bak; }

db_user() { docker exec "$DB_CONTAINER" printenv POSTGRES_USER; }
db_name() { docker exec "$DB_CONTAINER" printenv POSTGRES_DB; }
db_revision() {
    docker exec "$DB_CONTAINER" psql -U "$(db_user)" -d "$(db_name)" -tAc \
        "select version_num from alembic_version" 2>/dev/null | tr -d '[:space:]'
}

# ── 1. target ─────────────────────────────────────────────────
git diff --quiet HEAD -- || die "tracked files in this checkout have local changes; commit or discard them first"
if [ "$FETCH" -eq 1 ]; then
    git fetch --quiet origin || die "git fetch origin failed"
fi
TARGET=$(git rev-parse --verify --quiet "${REF}^{commit}") || die "unknown ref: $REF"
CURRENT=$(git rev-parse HEAD)
git merge-base --is-ancestor "$CURRENT" "$TARGET" \
    || die "$REF is not a fast-forward of the checked-out commit ($(git rev-parse --short HEAD)); refusing to deploy over diverged history"
TAG=$(git rev-parse --short=12 "$TARGET")
IMAGE="$IMAGE_REPO:$TAG"
PREV_TAG=$(env_get FORK_CORE_TAG)
RUNNING_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CORE_CONTAINER" 2>/dev/null || echo "not running")

echo ""
say "Deploying ${GREEN}$(git log -1 --format='%h %s' "$TARGET")${NC}"
say "${GRAY}checkout: $(git rev-parse --short HEAD) → $(git rev-parse --short "$TARGET")${NC}"
say "${GRAY}core:     $RUNNING_IMAGE → $IMAGE${NC}"
if [ "$CURRENT" != "$TARGET" ]; then
    git log --format='      %h %s' "$CURRENT..$TARGET" | head -20
fi
echo ""
if [ "$ASSUME_YES" -ne 1 ]; then
    read -rp "  Continue? [y/N]: " answer
    case "$answer" in y|Y|yes|YES) ;; *) say "Nothing changed."; exit 0 ;; esac
fi

# ── 2. build ──────────────────────────────────────────────────
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    ok "image $IMAGE already built"
else
    say "Building $IMAGE (several minutes) …"
    git archive --format=tar "$TARGET" \
        | docker build -t "$IMAGE" \
            --label "org.opencontainers.image.revision=$(git rev-parse "$TARGET")" \
            --label "org.opencontainers.image.source=$(git remote get-url origin)" - >>"$LOG" 2>&1 \
        || { show_log; die "build failed — nothing was changed"; }
    ok "built $IMAGE"
fi

# ── 3. backup ─────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/opennvr_db-$(date +%Y%m%d-%H%M%S)-before-$TAG.dump"
docker exec "$DB_CONTAINER" pg_dump -U "$(db_user)" -d "$(db_name)" -Fc > "$DUMP" \
    || { rm -f "$DUMP"; die "database backup failed — nothing was changed"; }
docker exec -i "$DB_CONTAINER" pg_restore --list < "$DUMP" >/dev/null \
    || die "backup $DUMP is unreadable — nothing was changed"
chmod 600 "$DUMP"
ok "database backed up to $DUMP"
# Prune: newest $BACKUPS_TO_KEEP dumps survive.
ls -1t "$BACKUP_DIR"/opennvr_db-*.dump 2>/dev/null | tail -n +$((BACKUPS_TO_KEEP + 1)) | while read -r old; do rm -f "$old"; done
PREV_REVISION=$(db_revision)

# ── 4/5. apply, verify, roll back on failure ──────────────────
rollback() {
    warn "rolling back …"
    set +e
    git reset --quiet --keep "$CURRENT"
    if [ -n "$PREV_TAG" ]; then env_set FORK_CORE_TAG "$PREV_TAG"; else env_unset FORK_CORE_TAG; fi
    if [ "$(db_revision)" != "$PREV_REVISION" ]; then
        warn "a migration ran — restoring the database from $DUMP"
        docker stop "$CORE_CONTAINER" >/dev/null
        docker exec -i "$DB_CONTAINER" pg_restore -U "$(db_user)" -d "$(db_name)" \
            --clean --if-exists --no-owner --single-transaction < "$DUMP" \
            || echo -e "  ${RED}✗ database restore failed — restore $DUMP by hand${NC}" >&2
    fi
    ./start.sh up >>"$LOG" 2>&1
    echo -e "  ${RED}✗ deploy failed; rolled back to $(git rev-parse --short HEAD) ($(docker inspect -f '{{.Config.Image}}' "$CORE_CONTAINER" 2>/dev/null))${NC}" >&2
    exit 1
}

git merge --quiet --ff-only "$TARGET" || die "fast-forward failed — nothing was changed"
env_set FORK_CORE_TAG "$TAG"
ok "checkout at $(git rev-parse --short HEAD), FORK_CORE_TAG=$TAG"

say "Restarting changed services with ./start.sh up …"
./start.sh up >>"$LOG" 2>&1 || { show_log; rollback; }

say "Waiting for core to report healthy …"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
while :; do
    running=$(docker inspect -f '{{.Config.Image}}' "$CORE_CONTAINER" 2>/dev/null || true)
    health=$(docker inspect -f '{{.State.Health.Status}}' "$CORE_CONTAINER" 2>/dev/null || true)
    if [ "$running" = "$IMAGE" ] && [ "$health" = "healthy" ]; then break; fi
    if [ "$health" = "unhealthy" ] || [ "$(date +%s)" -ge "$deadline" ]; then
        warn "core is '${health:-missing}' on '${running:-nothing}'"
        docker logs --tail 30 "$CORE_CONTAINER" 2>&1 | sed 's/^/      /'
        rollback
    fi
    sleep 3
done

ok "core healthy on $IMAGE (database revision $(db_revision))"
echo ""
