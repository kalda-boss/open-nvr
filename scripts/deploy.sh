#!/usr/bin/env bash
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Deploy this fork's core to the stack running from THIS checkout.
#
#   scripts/deploy.sh                 # deploy origin/main
#   scripts/deploy.sh --ref <commit>  # deploy a specific commit/branch
#   scripts/deploy.sh --check         # only the checks before step 2; change nothing
#   scripts/deploy.sh --yes           # no confirmation prompt
#   scripts/deploy.sh --allow-recorder-restart   # accept a gap in the footage
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
# Footage comes first. MediaMTX records every camera, and anything that
# restarts or reconfigures it loses footage on all of them: the 2026-10-19
# deploy of the RTCP fix cost 17 s per camera. Restarting core does not stop
# recording. The segments written while core is down are indexed by its
# reconciler when it comes back. So, before anything changes:
#
#   * the deploy is refused if the target would restart or reconfigure the
#     recorder: its Compose definition (Compose's own config hash, rendered
#     from the target tree, against the running container's), its
#     hot-reloaded config file, or the core code that provisions its paths
#     at startup. --allow-recorder-restart deploys it anyway, for a time
#     when a gap is acceptable;
#   * the cameras recording right now are noted.
#
# Afterwards, also after a rollback, it checks that the recorder is the same
# process, that every one of those cameras is still writing, and it measures
# the gaps between segment files since the deploy began. Exit status 2 means
# the deploy finished but that check found a problem.

set -Eeuo pipefail

cd "$(dirname "$0")/.."

IMAGE_REPO="ghcr.io/kalda-boss/open-nvr-core"   # keep in sync with docker-compose.yml
CORE_CONTAINER="opennvr_core"
DB_CONTAINER="opennvr_db"
BACKUP_DIR="${OPENNVR_BACKUP_DIR:-$HOME/opennvr-backups}"
BACKUPS_TO_KEEP=10
HEALTH_TIMEOUT_S=300

# The recorder. Its config file is bind-mounted and hot-reloaded; the core
# files provision its paths (source, recordPath, segment length) at startup.
# Its image (docker/mediamtx-build) is never rebuilt by this script.
REC_CONTAINER="opennvr_mediamtx"
REC_SERVICE="mediamtx"
REC_CONFIG="mediamtx.docker.yml"
REC_PROVISIONING="server/services/mediamtx_startup_service.py server/services/mediamtx_admin_service.py server/services/stream_service.py"
REC_IMAGE_CONTEXT="docker/mediamtx-build"

REF="origin/main"
ASSUME_YES=0
FETCH=1
CHECK_ONLY=0
ALLOW_RECORDER_RESTART=0

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; GRAY='\033[0;90m'; NC='\033[0m'
say()  { echo -e "  $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

# Build and launcher output goes here; its tail is shown when a step fails.
LOG=$(mktemp -t opennvr-deploy.XXXXXX)
show_log() { echo -e "  ${GRAY}── last lines of $LOG ──${NC}" >&2; tail -25 "$LOG" | sed 's/^/      /' >&2; }

usage() { sed -n '5,11p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --no-fetch) FETCH=0; shift ;;
        --check) CHECK_ONLY=1; shift ;;
        --allow-recorder-restart) ALLOW_RECORDER_RESTART=1; shift ;;
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
command -v python3 >/dev/null || die "python3 not found (the footage checks need it)"
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

fmt_time() { date -r "$1" +%H:%M:%S 2>/dev/null || date -d "@$1" +%H:%M:%S; }

recorder_identity() {
    docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$REC_CONTAINER" 2>/dev/null || echo "not running"
}

# Compose recreates a container when its config hash changes: render the
# recorder's from the target tree, with the arguments `./start.sh up` uses,
# and the project directory (paths, .env, project name) of this checkout.
recorder_target_hash() {
    local tree args a hash
    tree=$(mktemp -d -t opennvr-deploy-tree.XXXXXX)
    git archive "$TARGET" -- 'docker-compose*.yml' | tar -x -C "$tree" || true
    args=$(./start.sh compose-args 2>/dev/null) || args="-f docker-compose.yml"
    set -- $args
    local render=()
    while [ $# -gt 0 ]; do
        if [ "$1" = "-f" ] && [ $# -ge 2 ]; then render+=(-f "$tree/$2"); shift 2
        else render+=("$1"); shift; fi
    done
    hash=$(docker compose --project-directory "$PWD" ${render[@]+"${render[@]}"} config --hash "$REC_SERVICE" 2>/dev/null \
        | awk -v s="$REC_SERVICE" '$1 == s { print $2 }') || hash=""
    rm -rf "$tree"
    echo "$hash"
}

# The footage on disk, read directly (the database may lag): `live` lists
# the cameras whose newest segment was written in the last 30 s; `gaps <t>`
# lists every gap over 3 s between consecutive segments since epoch <t>.
# A segment starts at the time in its name (cam-N/YYYY-MM-DD/HH/MM-SS-us.mp4,
# in the recorder's TZ) and ends at its last write.
recording_scan() {
    local root
    root=$(env_get RECORDINGS_PATH)
    python3 - "${root:-./recordings}" "$(env_get TZ)" "$@" <<'PY'
import os, sys, time
from datetime import datetime

root, tzname, mode = sys.argv[1], sys.argv[2], sys.argv[3]
since = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
try:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(tzname) if tzname else None
except Exception:
    tz = None  # host local time, which the launcher also hands MediaMTX
now = time.time()

def subdirs(path):
    try:
        return sorted((e for e in os.scandir(path) if e.is_dir()), key=lambda e: e.name)
    except OSError:
        return []

def segments(cam):
    hours = [(day.name, hour) for day in subdirs(cam)[-2:] for hour in subdirs(day.path)]
    out = []
    for day, hour in sorted(hours, key=lambda dh: (dh[0], dh[1].name))[-2:]:
        try:
            files = list(os.scandir(hour.path))
        except OSError:
            continue
        for f in files:
            if not f.name.endswith(".mp4"):
                continue
            try:
                end = f.stat().st_mtime
                y, mo, d = (int(x) for x in day.split("-"))
                mi, s, us = (int(x) for x in f.name[:-4].split("-"))
                start = datetime(y, mo, d, int(hour.name), mi, s, us, tzinfo=tz).timestamp()
            except (OSError, ValueError):
                continue
            out.append((start, end))
    return sorted(out)

cams = [c for c in subdirs(root) if c.name.startswith("cam-") and not c.name.endswith("-sub")]
for cam in cams:
    segs = segments(cam.path)
    if mode == "live":
        if segs and now - max(end for _, end in segs) <= 30:
            print(cam.name)
    elif mode == "gaps":
        segs = [seg for seg in segs if seg[1] >= since - 120]
        for (_, end), (start, _) in zip(segs, segs[1:]):
            if start - end > 3:
                print("%s: %.1f s with no footage from %s"
                      % (cam.name, start - end, time.strftime("%H:%M:%S", time.localtime(end))))
PY
}

FOOTAGE_OK=1
verify_footage() {
    local missing live cam gaps deadline
    if [ "$(recorder_identity)" != "$REC_BEFORE" ]; then
        warn "the recorder restarted during this deploy"
        FOOTAGE_OK=0
    fi
    # A camera that dropped reconnects within seconds; give it a minute.
    deadline=$(( $(date +%s) + 60 ))
    while :; do
        live=" $( (recording_scan live || true) | tr '\n' ' ') "
        missing=""
        for cam in $RECORDING_BEFORE; do
            case "$live" in *" $cam "*) ;; *) missing="$missing $cam" ;; esac
        done
        if [ -z "$missing" ] || [ "$(date +%s)" -ge "$deadline" ]; then break; fi
        sleep 5
    done
    if [ -n "$missing" ]; then
        warn "not recording now, though they were before the deploy:$missing"
        FOOTAGE_OK=0
    else
        ok "all $(echo $RECORDING_BEFORE | wc -w | tr -d ' ') camera(s) that were recording still are"
    fi
    gaps=$(recording_scan gaps "$DEPLOY_START") || gaps="(the scan of the recordings failed)"
    if [ -n "$gaps" ]; then
        warn "gaps in the footage since the deploy began at $(fmt_time "$DEPLOY_START"):"
        echo "$gaps" | sed 's/^/      /'
        FOOTAGE_OK=0
    else
        ok "no gap in any camera's footage since $(fmt_time "$DEPLOY_START")"
    fi
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

# ── 1b. footage ───────────────────────────────────────────────
reasons=""
add_reason() { reasons="${reasons:+$reasons; }$*"; }
changed=$(git diff --name-only "$CURRENT" "$TARGET" -- $REC_CONFIG)
[ -n "$changed" ] && add_reason "its config ($REC_CONFIG, hot-reloaded)"
changed=$(git diff --name-only "$CURRENT" "$TARGET" -- $REC_PROVISIONING)
[ -n "$changed" ] && add_reason "how core provisions its paths ($(echo $changed))"
running_hash=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$REC_CONTAINER" 2>/dev/null || true)
if [ -n "$running_hash" ]; then
    target_hash=$(recorder_target_hash)
    if [ -z "$target_hash" ]; then
        add_reason "its Compose definition, which did not render for $TAG"
    elif [ "$target_hash" != "$running_hash" ]; then
        add_reason "its Compose definition (Compose would recreate it)"
    fi
else
    warn "the recorder ($REC_CONTAINER) isn't running; ./start.sh up will start it"
fi
if [ -n "$(git diff --name-only "$CURRENT" "$TARGET" -- $REC_IMAGE_CONTEXT)" ]; then
    warn "$REC_IMAGE_CONTEXT changed: this script does not rebuild the recorder's image, so that change is not deployed"
fi
if [ -n "$reasons" ]; then
    if [ "$ALLOW_RECORDER_RESTART" -eq 1 ]; then
        warn "this update restarts or reconfigures the recorder: $reasons"
        warn "every camera loses footage while it does (17 s each on 2026-10-19); --allow-recorder-restart accepts that"
    else
        die "this update would restart or reconfigure the recorder: $reasons.
     Every camera loses footage while that happens (17 s each on 2026-10-19).
     Deploy it when a gap is acceptable, with --allow-recorder-restart."
    fi
else
    ok "recorder untouched: MediaMTX keeps recording through the deploy"
fi
RECORDING_BEFORE=$(recording_scan live | tr '\n' ' ') || die "could not read the recordings under $(env_get RECORDINGS_PATH)"
if [ -n "$RECORDING_BEFORE" ]; then
    ok "recording now: $(echo $RECORDING_BEFORE | wc -w | tr -d ' ') camera(s) ($(echo $RECORDING_BEFORE))"
else
    warn "no camera has written a segment in the last 30 s: check the recorder before deploying"
fi
echo ""
if [ "$CHECK_ONLY" -eq 1 ]; then
    say "Checks only (--check): nothing changed."
    exit 0
fi

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
    verify_footage
    exit 1
}

REC_BEFORE=$(recorder_identity)
DEPLOY_START=$(date +%s)
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

say "Checking the footage …"
verify_footage
echo ""
if [ "$FOOTAGE_OK" -ne 1 ]; then
    echo -e "  ${RED}✗ deployed, but the footage check above found a problem${NC}" >&2
    exit 2
fi
