#!/usr/bin/env bash
# Reset the laptop-side sample-services daemon for a fresh test cycle:
#
#   - stop the sample-services daemon (~/.ocap-services);
#   - clear its log;
#   - bring it back up via start-services.sh, registering Echo and
#     RandomNumber with the supplied matcher URL.
#
# The matcher (which runs on the VPS) is reset separately by
# reset-everything.sh on that side.
#
# The matcher OCAP URL is required and is resolved in this order:
#   1. <matcher-url>            (positional argument)
#   2. $MATCHER_OCAP_URL        (environment variable)
#
# Prereqs: the relay must already be reachable from this host
# (`yarn ocap relay` locally, or a remote relay specified via
# --relay / $OCAP_RELAY_MULTIADDR).
#
# Usage:
#   reset-services.sh [<matcher-url>] [--no-build]
#
#   <matcher-url>   OCAP URL of the matcher to register with. Falls back
#                   to $MATCHER_OCAP_URL if omitted.
#   --no-build      Skip building/bundling the sample-services vats
#                   (passed through to start-services.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
START_SERVICES_SCRIPT="$SCRIPT_DIR/start-services.sh"
OCAP_BIN="$REPO_ROOT/packages/kernel-cli/dist/app.js"
SERVICES_HOME="${OCAP_SERVICES_HOME:-${HOME}/.ocap-services}"

PASSTHROUGH_ARGS=()
MATCHER_URL_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      PASSTHROUGH_ARGS+=(--no-build); shift ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" >&2; exit 0 ;;
    --*)
      echo "Error: unknown argument: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$MATCHER_URL_ARG" ]]; then
        MATCHER_URL_ARG="$1"; shift
      else
        echo "Error: unexpected positional argument: $1" >&2; exit 1
      fi
      ;;
  esac
done

info() { echo "[reset-services] $*" >&2; }

MATCHER_URL="${MATCHER_URL_ARG:-${MATCHER_OCAP_URL:-}}"
if [[ -z "$MATCHER_URL" ]]; then
  echo "[reset-services] ERROR: matcher URL required (pass as first argument or set \$MATCHER_OCAP_URL)." >&2
  exit 1
fi

if [[ ! -f "$OCAP_BIN" ]]; then
  echo "[reset-services] ERROR: ocap CLI not found at $OCAP_BIN." >&2
  echo "                 Run 'yarn workspace @metamask/kernel-cli build' first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Stop the services daemon.
# ---------------------------------------------------------------------------

info "Stopping sample-services daemon (if running)..."
node "$OCAP_BIN" --home "$SERVICES_HOME" daemon stop >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2. Clear the daemon log.
# ---------------------------------------------------------------------------

info "Clearing daemon log..."
rm -f "$SERVICES_HOME/daemon.log"

# ---------------------------------------------------------------------------
# 3. Bring the services daemon back up.
# ---------------------------------------------------------------------------

info "Starting sample-services daemon..."
"$START_SERVICES_SCRIPT" "$MATCHER_URL" ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"} >&2

cat <<EOF >&2

================================================================
SERVICES RESET COMPLETE.

  Echo and RandomNumber have re-registered with:
    $MATCHER_URL
================================================================
EOF
