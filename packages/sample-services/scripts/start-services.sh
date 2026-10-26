#!/usr/bin/env bash
# Start a sample-services daemon and launch the Echo and RandomNumber
# subclusters, each registering with the supplied service matcher.
#
# Like start-matcher.sh this is orthogonal to relay startup; the relay
# address is resolved from --relay / $OCAP_RELAY_MULTIADDR /
# $LIBP2P_RELAY_HOME/relay.addr / $HOME/.libp2p-relay/relay.addr in
# that order.
#
# The matcher OCAP URL is required and is resolved in this order:
#   1. <matcher-url>            (positional argument)
#   2. $MATCHER_OCAP_URL        (environment variable)
# The vats embed it in their bootstrap parameters so each one can
# register with the matcher on startup.
#
# Usage:
#   start-services.sh [<matcher-url>] [--relay MULTIADDR] [--no-build] [--keep-state]

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

RELAY_ADDR="${OCAP_RELAY_MULTIADDR:-}"
RELAY_FILE="${LIBP2P_RELAY_HOME:-${HOME}/.libp2p-relay}/relay.addr"
SKIP_BUILD=false
FORCE_RESET=true
MATCHER_URL_ARG=""

usage() {
  cat >&2 <<EOF
Usage: $0 [<matcher-url>] [--relay MULTIADDR] [--no-build] [--keep-state]

  <matcher-url>      OCAP URL of the matcher to register with. Falls
                     back to \$MATCHER_OCAP_URL if omitted.
  --relay MULTIADDR  Relay multiaddr to connect through. Overrides
                     \$OCAP_RELAY_MULTIADDR and
                     \$LIBP2P_RELAY_HOME/relay.addr.
  --no-build         Skip building/bundling the sample-services vats.
  --keep-state       Do not purge any existing daemon state before
                     launching subclusters.
  --help, -h         Show this help.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --relay)
      [[ $# -lt 2 ]] && { echo "Error: --relay requires a value" >&2; usage; }
      RELAY_ADDR="$2"; shift 2 ;;
    --no-build)
      SKIP_BUILD=true; shift ;;
    --keep-state)
      FORCE_RESET=false; shift ;;
    --help|-h)
      usage ;;
    --*)
      echo "Error: unknown argument: $1" >&2; usage ;;
    *)
      if [[ -z "$MATCHER_URL_ARG" ]]; then
        MATCHER_URL_ARG="$1"; shift
      else
        echo "Error: unexpected positional argument: $1" >&2; usage
      fi
      ;;
  esac
done

info() { echo "[start-services] $*" >&2; }
fail() { echo "[start-services] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Validate matcher URL up-front
# ---------------------------------------------------------------------------

MATCHER_URL="${MATCHER_URL_ARG:-${MATCHER_OCAP_URL:-}}"
if [[ -z "$MATCHER_URL" ]]; then
  fail "matcher URL required (pass as first argument or set \$MATCHER_OCAP_URL)."
fi
info "Matcher: $MATCHER_URL"

# ---------------------------------------------------------------------------
# Resolve relay address
# ---------------------------------------------------------------------------

if [[ -z "$RELAY_ADDR" && -f "$RELAY_FILE" ]]; then
  RELAY_ADDR="$(tr -d '[:space:]' < "$RELAY_FILE" || true)"
fi
if [[ -z "$RELAY_ADDR" ]]; then
  fail "No relay address supplied. Pass --relay, set \$OCAP_RELAY_MULTIADDR, or start the relay (\`yarn ocap relay\`) to populate $RELAY_FILE."
fi
info "Relay: $RELAY_ADDR"

# ---------------------------------------------------------------------------
# Locate the repo + bin paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
OCAP_BIN="$REPO_ROOT/packages/kernel-cli/dist/app.js"
ECHO_BUNDLE="$PKG_DIR/src/echo-service/index.bundle"
RNG_BUNDLE="$PKG_DIR/src/random-number-service/index.bundle"

# Sample-services daemon lives in its own home so it can run alongside
# the matcher (~/.ocap) and consumer (~/.ocap-consumer) daemons without
# colliding on socket paths or kernel.sqlite locks.
SERVICES_HOME="${OCAP_SERVICES_HOME:-${HOME}/.ocap-services}"

if [[ ! -f "$OCAP_BIN" ]]; then
  fail "ocap CLI not found at $OCAP_BIN. Run \`yarn workspace @metamask/kernel-cli build\` first."
fi

# ---------------------------------------------------------------------------
# Build & bundle
# ---------------------------------------------------------------------------

if $SKIP_BUILD; then
  info "Skipping build (--no-build)"
  [[ -f "$ECHO_BUNDLE" ]] || fail "Bundle not found at $ECHO_BUNDLE. Remove --no-build or build first."
  [[ -f "$RNG_BUNDLE" ]] || fail "Bundle not found at $RNG_BUNDLE. Remove --no-build or build first."
else
  info "Building sample-services package..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/sample-services build >&2)
  info "Bundling Echo and RandomNumber vats..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/sample-services bundle-vats >&2)
fi

# ---------------------------------------------------------------------------
# Start daemon under SERVICES_HOME
# ---------------------------------------------------------------------------

if $FORCE_RESET; then
  info "Purging existing services-daemon state at $SERVICES_HOME..."
  (cd "$REPO_ROOT" && node "$OCAP_BIN" --home "$SERVICES_HOME" daemon purge --force >&2) || true
fi

info "Starting services daemon..."
if ! (cd "$REPO_ROOT" && node "$OCAP_BIN" --home "$SERVICES_HOME" daemon start >&2); then
  info "daemon start failed — assuming one is already running"
fi

daemon_exec() {
  (cd "$REPO_ROOT" && node "$OCAP_BIN" --home "$SERVICES_HOME" daemon exec "$@")
}

# ---------------------------------------------------------------------------
# Initialize remote comms
# ---------------------------------------------------------------------------

RELAY_HOST=$(echo "$RELAY_ADDR" | node -e "
  const addr = require('fs').readFileSync('/dev/stdin','utf8').trim();
  const m = addr.match(/\\/(?:ip4|ip6|dns4|dns6)\\/([^\\/]+)/);
  if (m) process.stdout.write(m[1]);
")
COMMS_PARAMS=$(RELAY="$RELAY_ADDR" HOST="$RELAY_HOST" node -e "
  const params = { relays: [process.env.RELAY] };
  if (process.env.HOST) params.allowedWsHosts = [process.env.HOST];
  process.stdout.write(JSON.stringify(params));
")

info "Initializing remote comms..."
daemon_exec initRemoteComms "$COMMS_PARAMS" >/dev/null

info "Waiting for remote comms to connect..."
for i in $(seq 1 30); do
  STATUS=$(daemon_exec getStatus 2>/dev/null) || STATUS=""
  STATE=""
  if [[ -n "$STATUS" ]]; then
    STATE=$(echo "$STATUS" | node -e "
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      process.stdout.write(data.remoteComms?.state ?? 'none');
    ")
  fi
  if [[ "$STATE" == "connected" ]]; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    fail "Remote comms did not reach 'connected' state after 30s (current: ${STATE:-unknown})"
  fi
  sleep 1
done
info "Remote comms connected"

# ---------------------------------------------------------------------------
# Launch each service as its own subcluster.
#
# Each cluster config carries its own bundle plus the matcher URL in
# the bootstrap-vat's `parameters` bag. The vat reads the URL out of
# its parameters arg and registers with the matcher on bootstrap.
# ---------------------------------------------------------------------------

launch_service() {
  local svc_name="$1"
  local vat_name="$2"
  local bundle_path="$3"

  local config
  config=$(BUNDLE="file://$bundle_path" \
           VAT_NAME="$vat_name" \
           MATCHER_URL="$MATCHER_URL" \
           RESET="$FORCE_RESET" \
           node -e "
    const config = {
      config: {
        bootstrap: process.env.VAT_NAME,
        forceReset: process.env.RESET === 'true',
        services: ['ocapURLIssuerService', 'ocapURLRedemptionService'],
        vats: {
          [process.env.VAT_NAME]: {
            bundleSpec: process.env.BUNDLE,
            parameters: { matcherUrl: process.env.MATCHER_URL },
            // Both services use crypto.getRandomValues for registration
            // tokens; RandomNumber also uses it for its draws.
            globals: ['crypto']
          }
        }
      }
    };
    process.stdout.write(JSON.stringify(config));
  ")

  info "Launching $svc_name subcluster..."
  daemon_exec launchSubcluster "$config" >/dev/null
  info "$svc_name registered."
}

launch_service "Echo"            "echo"          "$ECHO_BUNDLE"
launch_service "RandomNumber"    "random-number" "$RNG_BUNDLE"

info "Sample services ready."
