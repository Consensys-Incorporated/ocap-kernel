#!/usr/bin/env bash
# Reset everything VPS-side for a fresh test cycle:
#
#   - stop both daemons (matcher under ~/.ocap, consumer under
#     ~/.ocap-consumer) and sweep up any orphan daemon-entry processes;
#   - purge consumer state and clear daemon logs in both homes
#     (the matcher's state is purged by start-matcher.sh as a side
#     effect of its default behavior);
#   - bring the matcher back up via start-matcher.sh, capturing the
#     newly-issued OCAP URL on stdout;
#   - bring the consumer daemon back up with --local-relay;
#   - update the openclaw discovery plugin's matcherUrl config and
#     restart the gateway so the new URL takes effect.
#
# After this finishes only the laptop-side steps remain: paste the URL
# into .metamaskrc, rebuild webpack, reload the extension. The URL is
# echoed in big letters at the very end so it's easy to copy.
#
# Prereqs: the relay must already be running (`yarn ocap relay`).
#
# Usage:
#   reset-everything.sh [--no-build]
#
#   --no-build   Skip building/bundling the matcher vat (passed through
#                to start-matcher.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OCAP_BIN="$REPO_ROOT/packages/kernel-cli/dist/app.js"
CONSUMER_HOME="${OCAP_CONSUMER_HOME:-${HOME}/.ocap-consumer}"
MATCHER_HOME="${HOME}/.ocap"
LLM_BRIDGE_PID_PATH="$MATCHER_HOME/matcher-llm-bridge.pid"
LLM_BRIDGE_LOG_PATH="$MATCHER_HOME/matcher-llm-bridge.log"
LLM_SOCKET_PATH="$MATCHER_HOME/matcher-llm.sock"

START_MATCHER_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      START_MATCHER_ARGS+=(--no-build); shift ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" >&2; exit 0 ;;
    *)
      echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

info() { echo "[reset] $*" >&2; }

if [[ ! -f "$OCAP_BIN" ]]; then
  echo "[reset] ERROR: ocap CLI not found at $OCAP_BIN." >&2
  echo "         Run 'yarn workspace @metamask/kernel-cli build' first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1-3. Stop both daemons; reap orphans.
# ---------------------------------------------------------------------------

info "Stopping consumer daemon (if running)..."
node "$OCAP_BIN" --home "$CONSUMER_HOME" daemon stop >/dev/null 2>&1 || true

info "Stopping matcher daemon (if running)..."
node "$OCAP_BIN" --home "$MATCHER_HOME" daemon stop >/dev/null 2>&1 || true

# Stop the matcher's llm-bridge process (started by start-matcher.sh).
if [[ -f "$LLM_BRIDGE_PID_PATH" ]]; then
  BRIDGE_PID="$(tr -d '[:space:]' < "$LLM_BRIDGE_PID_PATH" || true)"
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    info "Stopping llm-bridge (pid $BRIDGE_PID)..."
    kill "$BRIDGE_PID" 2>/dev/null || true
    sleep 0.5
    kill -KILL "$BRIDGE_PID" 2>/dev/null || true
  fi
  rm -f "$LLM_BRIDGE_PID_PATH"
fi
# Belt and suspenders: also reap any matcher-llm-bridge processes that
# escaped the pid file.
if pgrep -f 'llm-bridge/dist/index' >/dev/null 2>&1; then
  info "Reaping orphan llm-bridge processes..."
  pkill -f 'llm-bridge/dist/index' || true
  sleep 0.5
  pkill -KILL -f 'llm-bridge/dist/index' 2>/dev/null || true
fi
# Remove any stale Unix socket file the kernel left behind.
rm -f "$LLM_SOCKET_PATH"

# Sweep up anything that didn't shut down cleanly. start-matcher.sh and
# `daemon start` both refuse to take over a live daemon now, so leftovers
# from earlier sessions would otherwise block the next steps.
if pgrep -f daemon-entry >/dev/null 2>&1; then
  info "Reaping orphan daemon-entry processes..."
  pkill -f daemon-entry || true
  sleep 1
  pkill -KILL -f daemon-entry 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 4-5. Purge consumer state and clear logs.
# ---------------------------------------------------------------------------

info "Purging consumer daemon state..."
node "$OCAP_BIN" --home "$CONSUMER_HOME" daemon purge --force >/dev/null 2>&1 || true

info "Clearing daemon and bridge logs..."
rm -f \
  "$MATCHER_HOME/daemon.log" \
  "$CONSUMER_HOME/daemon.log" \
  "$LLM_BRIDGE_LOG_PATH"

# ---------------------------------------------------------------------------
# 6. Bring the matcher back up; capture the URL on stdout.
# ---------------------------------------------------------------------------

info "Starting matcher..."
MATCHER_URL="$("$SCRIPT_DIR/start-matcher.sh" ${START_MATCHER_ARGS[@]+"${START_MATCHER_ARGS[@]}"})"
if [[ -z "$MATCHER_URL" ]]; then
  echo "[reset] ERROR: start-matcher.sh produced no URL." >&2
  exit 1
fi
info "Matcher URL: $MATCHER_URL"

# ---------------------------------------------------------------------------
# 7. Bring the consumer daemon back up.
# ---------------------------------------------------------------------------

info "Starting consumer daemon (--local-relay)..."
node "$OCAP_BIN" --home "$CONSUMER_HOME" daemon start --local-relay >&2

# ---------------------------------------------------------------------------
# 9-10. Update the openclaw plugin config and restart the gateway.
# ---------------------------------------------------------------------------

info "Setting openclaw discovery plugin matcherUrl..."
openclaw config set 'plugins.entries.discovery.config.matcherUrl' "$MATCHER_URL"

info "Restarting openclaw gateway..."
openclaw gateway restart

# ---------------------------------------------------------------------------
# 11. Final reminder.
# ---------------------------------------------------------------------------

cat <<EOF >&2

================================================================
RESET COMPLETE.

  Matcher URL:
    $MATCHER_URL

  Next steps (laptop side only):
    1. Paste the URL above into .metamaskrc as MATCHER_OCAP_URL.
    2. Rebuild the extension's webpack bundle.
    3. Reload the extension in the browser.
================================================================
EOF
