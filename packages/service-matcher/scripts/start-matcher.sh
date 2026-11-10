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
# The matcher vat ranks via the `languageModelService` kernel service.
# This script provisions the daemon's LLM config (`llm.json` in the OCAP
# home) to point at openclaw's OpenAI-compatible /v1/chat/completions
# endpoint; the daemon registers the service at startup and reads the
# bearer token from this script's environment. Required env:
#   OPENCLAW_GATEWAY_TOKEN  Bearer token for the openclaw gateway. Must
#                           match `gateway.auth.token` in openclaw config.
#   OPENCLAW_GATEWAY_URL    Optional. Default http://127.0.0.1:18789.
#   OPENCLAW_AGENT_MODEL    Optional. Default "openclaw" (the gateway's
#                           configured default agent). Passed to the
#                           matcher vat as its `model` parameter.
# The matching openclaw config flag must be enabled on the gateway:
#   gateway.http.endpoints.chatCompletions.enabled = true
# `llm.json` stays in the OCAP home, and every later daemon start uses it,
# until `ocap daemon purge`.
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
  --no-build         Skip building/bundling the matcher vat.
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
  fail "OPENCLAW_GATEWAY_TOKEN must be set (the daemon's languageModelService calls the openclaw gateway with it)."
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

# Where the daemon reads its LLM config from at startup.
OCAP_HOME_DIR="${OCAP_HOME:-${HOME}/.ocap}"
LLM_CONFIG_PATH="$OCAP_HOME_DIR/llm.json"

if [[ ! -f "$OCAP_BIN" ]]; then
  fail "ocap CLI not found at $OCAP_BIN. Run \`yarn workspace @metamask/kernel-cli build\` first."
fi

# ---------------------------------------------------------------------------
# Build & bundle
# ---------------------------------------------------------------------------

if $SKIP_BUILD; then
  info "Skipping build (--no-build)"
  [[ -f "$BUNDLE_FILE" ]] || fail "Bundle not found at $BUNDLE_FILE. Remove --no-build or build first."
else
  info "Building service-matcher package..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/service-matcher build >&2)
  info "Bundling matcher vat..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/service-matcher bundle-vat >&2)
fi

# ---------------------------------------------------------------------------
# Start daemon
# ---------------------------------------------------------------------------

if $FORCE_RESET; then
  info "Purging existing daemon state..."
  (cd "$REPO_ROOT" && node "$OCAP_BIN" daemon purge --force >&2) || true
fi

# Provision the daemon's LLM config. Written after the purge (which
# deletes it) and before `daemon start` (which reads it once, at
# startup). The token itself stays out of the file: the daemon reads
# it from OPENCLAW_GATEWAY_TOKEN, inherited from this script's
# environment via `daemon start` below.
mkdir -p "$OCAP_HOME_DIR"
GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://127.0.0.1:18789}" node -e "
  const config = {
    provider: 'open-v1',
    baseUrl: process.env.GATEWAY_URL,
    apiKeyEnv: 'OPENCLAW_GATEWAY_TOKEN',
  };
  require('fs').writeFileSync(process.argv[1], JSON.stringify(config, null, 2) + '\n');
" "$LLM_CONFIG_PATH"
info "Wrote LLM config → $LLM_CONFIG_PATH"

# A daemon still running under --keep-state read llm.json, and the token,
# when it started; restart it so this run's URL and token take effect.
info "Restarting daemon..."
(cd "$REPO_ROOT" && node "$OCAP_BIN" daemon stop >&2) ||
  fail "Could not stop the running daemon."
(cd "$REPO_ROOT" && node "$OCAP_BIN" daemon start >&2) ||
  fail "Daemon failed to start; see $OCAP_HOME_DIR/daemon.log"

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
         MODEL="${OPENCLAW_AGENT_MODEL:-openclaw}" \
         node -e "
  const config = {
    config: {
      bootstrap: 'matcher',
      forceReset: process.env.RESET === 'true',
      services: [
        'ocapURLIssuerService',
        'ocapURLRedemptionService',
        'languageModelService',
      ],
      vats: {
        matcher: {
          bundleSpec: process.env.BUNDLE,
          parameters: { model: process.env.MODEL },
        }
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

info "Matcher ready."
echo "$MATCHER_URL"
