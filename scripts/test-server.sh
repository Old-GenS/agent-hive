#!/usr/bin/env bash
# test-server.sh - run a standing Agent Hive staging server for the newest test build.
#
# The staging server is `hive serve` running the newest `test-<run>-<version>` prerelease, started
# by `scripts/try-test-build.sh --serve` in a home of its own: its config, data and cache are under
# HIVE_TEST_SERVE_HOME (default $HIVE_TEST_BUILDS/serve), never the real install's keys, runs or
# settings. `install` writes a systemd user service for it and, unless asked not to, a timer that
# looks for a newer test build every 15 minutes. `update` switches builds only when no run is
# active on the staging server, so a timer never pulls a run out from under whoever is using it.
#
# This is the middle tier: :8080 is a source checkout, :8081 is the newest test build, and users
# get the releases that are promoted. The scripts themselves never contact GitHub; `update` asks
# try-test-build.sh, which does.
set -euo pipefail

# What the installer's environment set (a default is baked into every place it is used, so the
# units only pin a value somebody chose).
BUILDS_SET=${HIVE_TEST_BUILDS:-}
SERVE_HOME_SET=${HIVE_TEST_SERVE_HOME:-}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
HIVE_TEST_BUILDS=${HIVE_TEST_BUILDS:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-hive/test-builds}
HIVE_TEST_SERVE_HOME=${HIVE_TEST_SERVE_HOME:-$HIVE_TEST_BUILDS/serve}
UNIT_DIR=${HIVE_TEST_SERVER_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
HERE=$(dirname "$(readlink -f "$0")")
TRY=$HERE/try-test-build.sh

SERVICE=agent-hive-test.service
UPDATE_SERVICE=agent-hive-test-update.service
UPDATE_TIMER=agent-hive-test-update.timer

usage() {
  cat <<'EOF'
usage: test-server.sh install [--port <n>] [--host <addr>] [--no-auto-update]
       test-server.sh uninstall
       test-server.sh update
       test-server.sh status
       test-server.sh --help

Run a standing Agent Hive staging server: the newest test build, served on its own port from an
isolated home, kept current by a systemd user timer that switches only when no run is active.

  install    write and start the service, and (unless --no-auto-update) its update timer
  uninstall  stop and remove the units; the serve home is left in place
  update     switch to the newest test build if no run is active on staging
  status     whether the service is running, which build it serves and its URL

  --port <n>   with install: the port to serve on (default 8081)
  --host <addr> with install: the address to serve on (default 127.0.0.1)
  --no-auto-update  with install: do not write the update timer

environment: HIVE_TEST_BUILDS, HIVE_TEST_SERVE_HOME, HIVE_TEST_SERVER_UNIT_DIR, SYSTEMCTL
EOF
}

# The Environment= lines every unit shares: a PATH with the usual user bin directories, plus the
# two settings when the installer's environment set them.
environment_lines() {
  echo "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
  if [ -n "$BUILDS_SET" ]; then
    echo "Environment=HIVE_TEST_BUILDS=$HIVE_TEST_BUILDS"
  fi
  if [ -n "$SERVE_HOME_SET" ]; then
    echo "Environment=HIVE_TEST_SERVE_HOME=$HIVE_TEST_SERVE_HOME"
  fi
}

write_service() {
  local host=$1 port=$2
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$SERVICE" <<EOF
[Unit]
Description=Agent Hive staging server (newest test build, http://$host:$port/ui/)

[Service]
ExecStart=/usr/bin/env bash $TRY --serve --port $port --host $host
$(environment_lines)
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
EOF
}

write_update_units() {
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$UPDATE_SERVICE" <<EOF
[Unit]
Description=Update the Agent Hive staging server

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $HERE/test-server.sh update
$(environment_lines)
EOF
  cat >"$UNIT_DIR/$UPDATE_TIMER" <<EOF
[Unit]
Description=Look for a newer Agent Hive test build

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
EOF
}

current_tag() {
  if [ -f "$HIVE_TEST_SERVE_HOME/current" ]; then
    local tag
    tag=$(head -n 1 "$HIVE_TEST_SERVE_HOME/current" || true)
    if [ -n "$tag" ]; then
      echo "$tag"
      return
    fi
  fi
  echo none
}

# Whether the staging home has a run that is running or queued. Reads only the run's meta.json
# (the status the run engine writes); an unreadable file is not an active run.
run_active() {
  local candidates=("$HIVE_TEST_SERVE_HOME"/cache/agent-hive/runs/*/meta.json)
  local files=()
  local file
  for file in "${candidates[@]}"; do
    if [ -f "$file" ]; then
      files+=("$file")
    fi
  done
  if [ ${#files[@]} -eq 0 ]; then
    return 1
  fi
  node -e '
const fs = require("fs");
for (const file of process.argv.slice(1)) {
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    if (meta && (meta.status === "running" || meta.status === "queued")) process.exit(0);
  } catch {
    // Not a run we can read: not an active run.
  }
}
process.exit(1);
' "${files[@]}"
}

cmd_install() {
  local host=127.0.0.1
  local port=8081
  local auto_update=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --port)
        if [ $# -lt 2 ]; then
          usage >&2
          exit 2
        fi
        port=$2
        shift 2
        ;;
      --host)
        if [ $# -lt 2 ]; then
          usage >&2
          exit 2
        fi
        host=$2
        shift 2
        ;;
      --no-auto-update)
        auto_update=0
        shift
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
  done

  write_service "$host" "$port"
  if [ "$auto_update" = 1 ]; then
    write_update_units
  fi
  "$SYSTEMCTL" --user daemon-reload
  "$SYSTEMCTL" --user enable --now "$SERVICE"
  if [ "$auto_update" = 1 ]; then
    "$SYSTEMCTL" --user enable --now "$UPDATE_TIMER"
  fi
  echo "staging server: http://$host:$port/ui/"
  echo "log in with API_TOKEN from $HIVE_TEST_SERVE_HOME/config/agent-hive/env"
}

cmd_uninstall() {
  "$SYSTEMCTL" --user disable --now "$SERVICE" 2>/dev/null || true
  "$SYSTEMCTL" --user disable --now "$UPDATE_TIMER" 2>/dev/null || true
  rm -f "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$UPDATE_SERVICE" "$UNIT_DIR/$UPDATE_TIMER"
  "$SYSTEMCTL" --user daemon-reload
  echo "removed the staging server units from $UNIT_DIR"
  echo "its home is still at $HIVE_TEST_SERVE_HOME; remove the test-build cache (including that home) with: bash $TRY --clean"
}

cmd_update() {
  local current
  current=$(current_tag)

  local list
  if ! list=$("$TRY" --list 2>/dev/null); then
    echo "could not list test builds; staying on $current"
    exit 0
  fi
  local tag
  tag=$(printf '%s\n' "$list" | head -n 1)
  tag=${tag%%[[:space:]]*}
  if [ -z "$tag" ]; then
    echo "could not list test builds; staying on $current"
    exit 0
  fi

  if [ "$tag" = "$current" ]; then
    echo "up to date: $tag"
    exit 0
  fi

  if run_active; then
    echo "a run is active on staging; not switching to $tag yet"
    exit 0
  fi

  # Download and verify the new build; its stdout is only for the print mode.
  if ! "$TRY" "$tag" >/dev/null; then
    exit 1
  fi

  "$SYSTEMCTL" --user restart "$SERVICE"
  echo "switched staging to $tag"
}

cmd_status() {
  local state
  state=$("$SYSTEMCTL" --user is-active "$SERVICE" 2>&1 || true)
  echo "service: $state"

  echo "build: $(current_tag)"

  local description url
  if [ -f "$UNIT_DIR/$SERVICE" ]; then
    description=$(grep -m 1 '^Description=' "$UNIT_DIR/$SERVICE" || true)
    url=$(printf '%s\n' "$description" | sed -n 's/.*\(http[^)]*\).*/\1/p')
    if [ -n "$url" ]; then
      echo "url: $url"
    fi
  fi

  echo "log in with API_TOKEN from $HIVE_TEST_SERVE_HOME/config/agent-hive/env"
}

command=${1:-}
if [ $# -gt 0 ]; then
  shift
fi

case "$command" in
  install)
    cmd_install "$@"
    ;;
  uninstall)
    cmd_uninstall
    ;;
  update)
    cmd_update
    ;;
  status)
    cmd_status
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
