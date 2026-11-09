#!/usr/bin/env bash
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Install (or update) the host recording reader on macOS as a LaunchAgent.
#
#   scripts/recording-reader/install.sh --env /path/to/live/.env
#   scripts/recording-reader/install.sh --uninstall --env /path/to/live/.env
#
# Why: Docker Desktop reads the recordings drive through its file sharing at a
# few MB/s; this reader serves the same files from the host at 100+ MB/s, so
# fast playback (8x) keeps up. See recording_reader.py.
#
# What it does:
#   1. Copies recording_reader.py to ~/Library/Application Support/OpenNVR/
#      recording-reader/ and creates a random token there (mode 600) unless
#      one exists.
#   2. Writes ~/Library/LaunchAgents/com.opennvr.recording-reader.plist and
#      (re)starts it: loopback only, port 8790, starts at login, restarted if
#      it exits. It serves RECORDINGS_PATH from the .env, read-only.
#   3. Checks it can read a recording (macOS may need to grant python3 access
#      to the external drive: System Settings > Privacy & Security > Files and
#      Folders / Full Disk Access).
#   4. Sets RECORDING_READER_URL and RECORDING_READER_TOKEN in the .env. Core
#      reads them on its next (re)create: run scripts/deploy.sh or
#      ./start.sh up. Never touches the recorder.
#
# Without the reader (stopped, uninstalled, or unreachable) core reads the
# mount as before: only speed changes.

set -Eeuo pipefail

LABEL="com.opennvr.recording-reader"
PORT=8790
PY=/usr/bin/python3
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/OpenNVR/recording-reader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/opennvr-recording-reader.log"
ENV_FILE=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '4,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || { echo "--env must name the live .env file" >&2; exit 2; }
[ "$(uname)" = Darwin ] || { echo "macOS only (Linux reads the mount at full speed already)" >&2; exit 2; }

# Set KEY=VALUE in the .env (replace or append) without printing the value.
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  KEY="$key" VALUE="$value" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  chmod "$(stat -f %Lp "$ENV_FILE")" "$tmp"
  mv "$tmp" "$ENV_FILE"
}

if [ "$UNINSTALL" = 1 ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  set_env RECORDING_READER_URL ""
  set_env RECORDING_READER_TOKEN ""
  echo "Reader removed. Core keeps using it until recreated (./start.sh up), then reads the mount."
  exit 0
fi

ROOT="$(grep -E '^RECORDINGS_PATH=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$ROOT" ] || { echo "RECORDINGS_PATH is not set in $ENV_FILE" >&2; exit 2; }
case "$ROOT" in /*) ;; *) ROOT="$(cd "$(dirname "$ENV_FILE")" && cd "$ROOT" && pwd)" ;; esac

mkdir -p "$APP_DIR" "$(dirname "$PLIST")" "$(dirname "$LOG")"
install -m 644 "$HERE/recording_reader.py" "$APP_DIR/recording_reader.py"
if [ ! -s "$APP_DIR/token" ]; then
  (umask 077; "$PY" -c 'import secrets; print(secrets.token_urlsafe(32))' > "$APP_DIR/token")
fi
chmod 600 "$APP_DIR/token"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$(xml "$APP_DIR/recording_reader.py")</string>
    <string>--root</string><string>$(xml "$ROOT")</string>
    <string>--token-file</string><string>$(xml "$APP_DIR/token")</string>
    <string>--bind</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  sleep 1
done

# Check it serves a real recording (this is where a missing macOS permission
# for the external drive shows up).
SAMPLE="$(find "$ROOT" -name '*.mp4' -type f -mmin +5 2>/dev/null | head -1 || true)"
REL="${SAMPLE#"$ROOT"/}"
if ! "$PY" - "$PORT" "$APP_DIR/token" "$REL" <<'EOF'
import sys, time, urllib.request, urllib.parse, urllib.error
port, token_file, rel = sys.argv[1], sys.argv[2], sys.argv[3]
token = open(token_file).read().strip()
base = f"http://127.0.0.1:{port}"
for _ in range(40):
    try:
        urllib.request.urlopen(base + "/health", timeout=2).read()
        break
    except OSError:
        time.sleep(0.25)
else:
    sys.exit("the reader did not start")
if rel:
    req = urllib.request.Request(base + "/f/" + urllib.parse.quote(rel),
                                 headers={"Authorization": "Bearer " + token, "Range": "bytes=0-7"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except urllib.error.HTTPError as e:
        sys.exit(f"the reader could not read a recording (HTTP {e.code})")
EOF
then
  echo "See $LOG. If it is a permission error, allow $PY to read the drive" >&2
  echo "(System Settings > Privacy & Security > Full Disk Access) and run this again." >&2
  exit 1
fi

set_env RECORDING_READER_URL "http://host.docker.internal:$PORT"
set_env RECORDING_READER_TOKEN "$(cat "$APP_DIR/token")"
echo "Recording reader running on 127.0.0.1:$PORT, serving $ROOT."
echo "Set RECORDING_READER_URL/TOKEN in $ENV_FILE; core picks them up when recreated (scripts/deploy.sh or ./start.sh up)."
