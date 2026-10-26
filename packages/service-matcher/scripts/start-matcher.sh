#!/usr/bin/env bash
# Start a service-matcher daemon and print its OCAP URL.
#
# This script is orthogonal to relay startup: it does not start a relay,
# and the relay does not need to know anything about this script. The two
# can be started in either order; whichever one starts second picks up
# the other's state.
#
# The relay's multiaddr is resolved in this order:
#   1. --relay <multiaddr>             (explicit override on the CLI)
#   2. $OCAP_RELAY_MULTIADDR           (environment variable)
#   3. $LIBP2P_RELAY_HOME/relay.addr   (if $LIBP2P_RELAY_HOME is set)
#   4. $HOME/.libp2p-relay/relay.addr  (default; written by `yarn ocap relay`)
# If none of these yields an address the script exits with an error so
# the operator can start the relay first (or pass its address directly).
#
# The matcher vat now ranks via an LLM-backed bridge process
# (`@ocap/llm-bridge`) connected through a Unix-socket IOChannel. This
# script also starts the bridge, which calls openclaw's OpenAI-compatible
# /v1/chat/completions endpoint. Required env:
#   OPENCLAW_GATEWAY_TOKEN  Bearer token for the openclaw gateway. Must
#                           match `gateway.auth.token` in openclaw config.
#   OPENCLAW_GATEWAY_URL    Optional. Default http://127.0.0.1:18789.
#   OPENCLAW_AGENT_MODEL    Optional. Default "openclaw" (the gateway's
#                           configured default agent).
# The matching openclaw config flag must be enabled on the gateway:
#   gateway.http.endpoints.chatCompletions.enabled = true
#
# Usage:
#   start-matcher.sh [--relay MULTIADDR] [--no-build] [--keep-state]
#
# On success the matcher's OCAP URL is printed to stdout on its own
# line — all progress messages go to stderr — so:
#   MATCHER_OCAP_URL=$(start-matcher.sh)
# works as expected.

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

RELAY_ADDR="${OCAP_RELAY_MULTIADDR:-}"
RELAY_FILE="${LIBP2P_RELAY_HOME:-${HOME}/.libp2p-relay}/relay.addr"
SKIP_BUILD=false
FORCE_RESET=true

usage() {
  cat >&2 <<EOF
Usage: $0 [--relay MULTIADDR] [--no-build] [--keep-state]

  --relay MULTIADDR  Relay multiaddr to connect through. Overrides
                     \$OCAP_RELAY_MULTIADDR and
                     \$LIBP2P_RELAY_HOME/relay.addr (default
                     \$HOME/.libp2p-relay/relay.addr).
  --no-build         Skip building/bundling the matcher vat and
                     building the llm-bridge package.
  --keep-state       Do not purge any existing daemon state before
                     launching the matcher subcluster.
  --help, -h         Show this help.

Required env:
  OPENCLAW_GATEWAY_TOKEN   Bearer token for the openclaw gateway.

Optional env:
  OPENCLAW_GATEWAY_URL     Default http://127.0.0.1:18789.
  OPENCLAW_AGENT_MODEL     Default "openclaw".
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
    *)
      echo "Error: unknown argument: $1" >&2; usage ;;
  esac
done

info() { echo "[start-matcher] $*" >&2; }
fail() { echo "[start-matcher] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Validate env up-front (before tearing anything down)
# ---------------------------------------------------------------------------

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  fail "OPENCLAW_GATEWAY_TOKEN must be set (the matcher vat now talks to an LLM bridge that calls the openclaw gateway)."
fi

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
BUNDLE_FILE="$PKG_DIR/src/matcher-vat/index.bundle"
LLM_BRIDGE_BIN="$REPO_ROOT/packages/llm-bridge/dist/index.js"

# Where the matcher vat's `llm` IOService lives, plus bookkeeping files
# for the bridge process this script will spawn.
OCAP_HOME_DIR="${OCAP_HOME:-${HOME}/.ocap}"
LLM_SOCKET_PATH="$OCAP_HOME_DIR/matcher-llm.sock"
LLM_BRIDGE_PID_PATH="$OCAP_HOME_DIR/matcher-llm-bridge.pid"
LLM_BRIDGE_LOG_PATH="$OCAP_HOME_DIR/matcher-llm-bridge.log"

if [[ ! -f "$OCAP_BIN" ]]; then
  fail "ocap CLI not found at $OCAP_BIN. Run \`yarn workspace @metamask/kernel-cli build\` first."
fi

# ---------------------------------------------------------------------------
# Build & bundle
# ---------------------------------------------------------------------------

if $SKIP_BUILD; then
  info "Skipping build (--no-build)"
  [[ -f "$BUNDLE_FILE" ]] || fail "Bundle not found at $BUNDLE_FILE. Remove --no-build or build first."
  [[ -f "$LLM_BRIDGE_BIN" ]] || fail "llm-bridge build not found at $LLM_BRIDGE_BIN. Remove --no-build or build first."
else
  info "Building service-matcher package..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/service-matcher build >&2)
  info "Bundling matcher vat..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/service-matcher bundle-vat >&2)
  info "Building llm-bridge package..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/llm-bridge build >&2)
fi

# ---------------------------------------------------------------------------
# Reap any old llm-bridge process from a previous run
# ---------------------------------------------------------------------------

if [[ -f "$LLM_BRIDGE_PID_PATH" ]]; then
  OLD_PID="$(tr -d '[:space:]' < "$LLM_BRIDGE_PID_PATH" || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    info "Reaping previous llm-bridge (pid $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.5
    kill -KILL "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$LLM_BRIDGE_PID_PATH"
fi

# ---------------------------------------------------------------------------
# Start daemon
# ---------------------------------------------------------------------------

if $FORCE_RESET; then
  info "Purging existing daemon state..."
  (cd "$REPO_ROOT" && node "$OCAP_BIN" daemon purge --force >&2) || true
fi

info "Starting daemon..."
# `daemon start` fails if one is already running; detect and continue.
if ! (cd "$REPO_ROOT" && node "$OCAP_BIN" daemon start >&2); then
  info "daemon start failed — assuming one is already running"
fi

daemon_exec() {
  (cd "$REPO_ROOT" && node "$OCAP_BIN" daemon exec "$@")
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
# Launch the matcher subcluster
# ---------------------------------------------------------------------------

CONFIG=$(BUNDLE="file://$BUNDLE_FILE" \
         RESET="$FORCE_RESET" \
         LLM_SOCKET="$LLM_SOCKET_PATH" \
         node -e "
  const config = {
    config: {
      bootstrap: 'matcher',
      forceReset: process.env.RESET === 'true',
      services: ['ocapURLIssuerService', 'ocapURLRedemptionService'],
      io: {
        llm: { type: 'socket', path: process.env.LLM_SOCKET }
      },
      vats: {
        matcher: { bundleSpec: process.env.BUNDLE }
      }
    }
  };
  process.stdout.write(JSON.stringify(config));
")

info "Launching matcher subcluster..."
LAUNCH_RESULT=$(daemon_exec launchSubcluster "$CONFIG")

MATCHER_URL=$(echo "$LAUNCH_RESULT" | node -e "
  const raw = require('fs').readFileSync('/dev/stdin','utf8').trim();
  const data = JSON.parse(raw);
  // bootstrapResult may be CapData { body, slots } or a plain object.
  const br = data.bootstrapResult;
  let url;
  if (br && typeof br === 'object' && typeof br.body === 'string') {
    const body = br.body.replace(/^#/u, '');
    url = JSON.parse(body).matcherUrl;
  } else if (br && typeof br === 'object') {
    url = br.matcherUrl;
  }
  if (!url) {
    process.stderr.write('Could not extract matcherUrl from: ' + raw + '\\n');
    process.exit(1);
  }
  process.stdout.write(url);
")

# ---------------------------------------------------------------------------
# Start the LLM bridge
#
# The matcher subcluster is now running, which means the kernel has
# created the Unix socket at $LLM_SOCKET_PATH. Spawn the bridge as a
# detached background process; it will connect to the socket (with its
# own retry loop) and proxy ingest/query traffic to the openclaw
# gateway.
# ---------------------------------------------------------------------------

info "Starting llm-bridge..."
mkdir -p "$OCAP_HOME_DIR"
: > "$LLM_BRIDGE_LOG_PATH"

# Export the socket path so the bridge picks it up. The other env
# vars (OPENCLAW_GATEWAY_TOKEN/_URL/_MODEL) are inherited verbatim
# from this script's environment.
export LLM_BRIDGE_SOCKET="$LLM_SOCKET_PATH"

# `setsid` (where available) detaches the bridge from this script's
# process group so a `kill` on the script doesn't take the bridge with
# it. macOS doesn't ship setsid by default; fall back to `nohup`.
if command -v setsid >/dev/null 2>&1; then
  setsid node "$LLM_BRIDGE_BIN" >>"$LLM_BRIDGE_LOG_PATH" 2>&1 &
else
  nohup node "$LLM_BRIDGE_BIN" >>"$LLM_BRIDGE_LOG_PATH" 2>&1 &
fi
LLM_BRIDGE_PID=$!
echo "$LLM_BRIDGE_PID" > "$LLM_BRIDGE_PID_PATH"
info "llm-bridge spawned (pid $LLM_BRIDGE_PID); log → $LLM_BRIDGE_LOG_PATH"

# Quick liveness check: if the bridge died immediately (e.g. token
# misconfigured at the openclaw side), surface that here rather than
# letting the operator discover it on the first registration attempt.
sleep 0.5
if ! kill -0 "$LLM_BRIDGE_PID" 2>/dev/null; then
  rm -f "$LLM_BRIDGE_PID_PATH"
  fail "llm-bridge exited immediately — see $LLM_BRIDGE_LOG_PATH"
fi

info "Matcher ready."
echo "$MATCHER_URL"
