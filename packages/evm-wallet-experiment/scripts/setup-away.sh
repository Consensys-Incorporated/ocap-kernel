#!/usr/bin/env bash
# Setup script for the AWAY wallet device (agent machine).
#
# Starts the daemon, launches the wallet subcluster, initialises a throwaway
# keyring, connects to the home wallet via the provided OCAP URL, and verifies
# the peer connection.
#
# Usage:
#   ./setup-away.sh --ocap-url "ocap:..." --listen-addrs '["/ip4/..."]' [options]
#
# Required:
#   --ocap-url      The OCAP URL issued by the home device (from setup-home.sh)
#   --listen-addrs  JSON array of home device listen addresses (from setup-home.sh)
#
# Optional:
#   --infura-key  KEY   Infura API key (for direct chain queries)
#   --pimlico-key KEY   Pimlico API key (for bundler / paymaster)
#   --chain         NAME  Chain name (e.g. sepolia, base, ethereum). See --help.
#   --chain-id      ID    Chain ID (default: 11155111 = Sepolia)
#   --rpc-url       URL   Custom RPC URL (overrides Infura URL derivation)
#   --no-build            Skip the build step

set -euo pipefail

SCRIPT_DIR_EARLY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-chain.sh
source "$SCRIPT_DIR_EARLY/resolve-chain.sh"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

CHAIN_ID=11155111
PIMLICO_KEY=""
OCAP_URL=""
INFURA_KEY=""
LISTEN_ADDRS=""
RELAY_ADDR=""
SKIP_BUILD=false
QUIC_PORT=4002
CUSTOM_RPC_URL=""
NON_INTERACTIVE=false

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $0 --ocap-url "ocap:..." --listen-addrs '["/ip4/..."]' [--infura-key KEY] [--pimlico-key KEY] [--chain NAME] [--quic-port PORT] [--no-build]

Required:
  --ocap-url       OCAP URL from the home device (output of setup-home.sh)
  --listen-addrs   JSON array of home device listen addresses (output of setup-home.sh)

Optional:
  --infura-key     Infura API key (for direct chain queries)
  --pimlico-key    Pimlico API key (bundler/paymaster)
  --relay          Relay multiaddr (e.g. /ip4/HOST/tcp/9001/ws/p2p/PEER_ID)
  --chain          Chain name (e.g. sepolia, base, ethereum)
  --chain-id       Chain ID (alternative to --chain; default: $CHAIN_ID)
  --rpc-url        Custom RPC URL (overrides Infura URL derivation)
  --quic-port      UDP port for QUIC transport (default: $QUIC_PORT)
  --no-build       Skip yarn build
  --non-interactive  Skip interactive prompts (for Docker/CI)
EOF
  print_supported_chains
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ocap-url)
      [[ $# -lt 2 ]] && { echo "Error: --ocap-url requires a value" >&2; usage; }
      OCAP_URL="$2"; shift 2 ;;
    --listen-addrs)
      [[ $# -lt 2 ]] && { echo "Error: --listen-addrs requires a value" >&2; usage; }
      LISTEN_ADDRS="$2"; shift 2 ;;
    --infura-key)
      [[ $# -lt 2 ]] && { echo "Error: --infura-key requires a value" >&2; usage; }
      INFURA_KEY="$2"; shift 2 ;;
    --pimlico-key)
      [[ $# -lt 2 ]] && { echo "Error: --pimlico-key requires a value" >&2; usage; }
      PIMLICO_KEY="$2"; shift 2 ;;
    --chain)
      [[ $# -lt 2 ]] && { echo "Error: --chain requires a value" >&2; usage; }
      resolve_chain "$2" || exit 1; shift 2 ;;
    --chain-id)
      [[ $# -lt 2 ]] && { echo "Error: --chain-id requires a value" >&2; usage; }
      resolve_chain "$2" || exit 1; shift 2 ;;
    --rpc-url)
      [[ $# -lt 2 ]] && { echo "Error: --rpc-url requires a value" >&2; usage; }
      CUSTOM_RPC_URL="$2"; shift 2 ;;
    --relay)
      [[ $# -lt 2 ]] && { echo "Error: --relay requires a value" >&2; usage; }
      RELAY_ADDR="$2"; shift 2 ;;
    --quic-port)
      [[ $# -lt 2 ]] && { echo "Error: --quic-port requires a value" >&2; usage; }
      QUIC_PORT="$2"; shift 2 ;;
    --no-build)    SKIP_BUILD=true; shift ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    -h|--help)     usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$OCAP_URL" ]]; then
  echo "Error: --ocap-url is required." >&2
  usage
fi

if [[ "$OCAP_URL" != ocap:* ]]; then
  echo "Error: OCAP URL must start with 'ocap:'." >&2
  exit 1
fi

if [[ -z "$LISTEN_ADDRS" ]]; then
  echo "Error: --listen-addrs is required." >&2
  usage
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not found on PATH." >&2
  exit 1
fi

if ! command -v yarn &>/dev/null; then
  echo "Error: yarn is required but not found on PATH. Run: npm install -g yarn" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
BUNDLE_DIR="$PKG_ROOT/src/vats"
OCAP_BIN="$REPO_ROOT/packages/kernel-cli/dist/app.mjs"

if [[ ! -f "$OCAP_BIN" ]]; then
  echo "Error: ocap CLI not found at $OCAP_BIN. Run 'yarn workspace @metamask/kernel-cli build' first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RESET='\033[0m'

info()  { echo -e "${CYAN}→${RESET} $*" >&2; }
ok()    { echo -e "  ${GREEN}✓${RESET} $*" >&2; }
fail()  { echo -e "  ${RED}✗${RESET} $*" >&2; exit 1; }

# Run a daemon exec command and log its output to stderr.
# Usage: daemon_exec [--quiet] <method> <params> [--timeout <seconds>]
# Pass --quiet to suppress the stderr log line (for sensitive params).
daemon_exec() {
  local quiet=false
  if [[ "${1:-}" == "--quiet" ]]; then
    quiet=true
    shift
  fi
  local result
  result=$(node "$OCAP_BIN" daemon exec "$@")
  if [[ -n "$result" && "$quiet" == false ]]; then
    echo "  [daemon exec $1] $result" >&2
  fi
  echo "$result"
}

# Run `ocap daemon queueMessage` (auto-decodes CapData via prettifySmallcaps).
# Usage: daemon_qm [--quiet] KREF METHOD [ARGS_JSON] [--timeout N] [--raw]
# --quiet suppresses the stderr log line
# Remaining args are passed through to the CLI (including --raw, --timeout).
daemon_qm() {
  local quiet=false
  if [[ "${1:-}" == "--quiet" ]]; then
    quiet=true
    shift
  fi
  # $1=kref, $2=method after any --quiet shift
  local method="${2:-}"
  local result
  result=$(node "$OCAP_BIN" daemon queueMessage "$@")
  if [[ -n "$result" && "$quiet" == false ]]; then
    echo "  [queueMessage $method] $result" >&2
  fi
  echo "$result"
}

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------

if [[ "$SKIP_BUILD" == false ]]; then
  info "Building packages..."
  (cd "$REPO_ROOT" && yarn workspace @metamask/ocap-kernel build) >&2
  (cd "$REPO_ROOT" && yarn workspace @metamask/kernel-node-runtime build) >&2
  (cd "$REPO_ROOT" && yarn workspace @metamask/kernel-cli build) >&2
  (cd "$REPO_ROOT" && yarn workspace @ocap/evm-wallet-experiment build) >&2
  ok "Build complete"
else
  info "Skipping build (--no-build)"
  if [[ ! -f "$BUNDLE_DIR/away-coordinator.bundle" ]]; then
    fail "Bundle files not found in $BUNDLE_DIR. Remove --no-build to build first."
  fi
fi

# ---------------------------------------------------------------------------
# 2. Start daemon
# ---------------------------------------------------------------------------

info "Starting daemon..."
node "$OCAP_BIN" daemon start >&2
ok "Daemon running"

# ---------------------------------------------------------------------------
# 3. Initialize remote comms (libp2p)
# ---------------------------------------------------------------------------

if [[ -n "$RELAY_ADDR" ]]; then
  info "Initializing remote comms (relay: ${RELAY_ADDR})..."
else
  info "Initializing remote comms (direct QUIC on port $QUIC_PORT)..."
fi
COMMS_PARAMS=$(QUIC="$QUIC_PORT" RELAY="$RELAY_ADDR" node -e "
  const p = { directListenAddresses: ['/ip4/0.0.0.0/udp/' + process.env.QUIC + '/quic-v1'] };
  const relay = process.env.RELAY;
  if (relay) {
    p.relays = [relay];
    const m = relay.match(/\\/(?:ip4|ip6|dns4|dns6)\\/([^\\/]+)/);
    if (m) p.allowedWsHosts = [m[1]];
  }
  process.stdout.write(JSON.stringify(p));
")
daemon_exec initRemoteComms "$COMMS_PARAMS" >/dev/null
ok "Remote comms initialized"

# Wait for remote comms to reach 'connected' state
info "Waiting for remote comms to connect..."
for i in $(seq 1 30); do
  STATUS=$(node "$OCAP_BIN" daemon exec getStatus 2>/dev/null) || STATUS=""
  if [[ -z "$STATUS" ]]; then
    sleep 1
    continue
  fi
  STATE=$(echo "$STATUS" | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    process.stdout.write(data.remoteComms?.state ?? 'none');
  ")
  if [[ "$STATE" == "connected" ]]; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    fail "Remote comms did not reach 'connected' state after 30s (current: $STATE)"
  fi
  sleep 1
done
ok "Remote comms connected"

# If a relay is configured, verify the relay reservation is actually active
# by waiting for circuit relay addresses to appear in getMultiaddrs().
if [[ -n "$RELAY_ADDR" ]]; then
  info "Verifying relay reservation..."
  RELAY_OK=false
  for i in $(seq 1 30); do
    STATUS=$(node "$OCAP_BIN" daemon exec getStatus 2>/dev/null) || STATUS=""
    if [[ -n "$STATUS" ]]; then
      HAS_CIRCUIT=$(echo "$STATUS" | node -e "
        const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
        const addrs = data.remoteComms?.listenAddresses ?? [];
        process.stdout.write(String(addrs.some(a => a.includes('/p2p-circuit/'))));
      ")
      if [[ "$HAS_CIRCUIT" == "true" ]]; then
        RELAY_OK=true
        break
      fi
    fi
    sleep 1
  done
  if [[ "$RELAY_OK" == "true" ]]; then
    ok "Relay reservation active"
  else
    fail "Relay reservation not established after 30s. Is the relay running? Check: sudo systemctl status ocap-relay.service"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Register home device location hints
# ---------------------------------------------------------------------------

info "Registering home device location hints..."

# OCAP URL format: ocap:<oid>@<peerId>,<hint1>,<hint2>,...
HOME_PEER_ID=$(echo "$OCAP_URL" | node -e "
  const url = require('fs').readFileSync('/dev/stdin', 'utf8').trim();
  const withoutScheme = url.replace(/^ocap:/, '');
  const afterAt = withoutScheme.split('@')[1];
  if (!afterAt) {
    process.stderr.write('Failed to parse OCAP URL: no @ separator found in: ' + url.slice(0, 100) + '\n');
    process.exit(1);
  }
  const peerId = afterAt.split(',')[0];
  if (!peerId) {
    process.stderr.write('Failed to parse OCAP URL: no peer ID found after @ in: ' + url.slice(0, 100) + '\n');
    process.exit(1);
  }
  process.stdout.write(peerId);
")

if [[ -z "$HOME_PEER_ID" ]]; then
  fail "Failed to extract peer ID from OCAP URL"
fi

HINTS_PARAMS=$(PEER="$HOME_PEER_ID" ADDRS="$LISTEN_ADDRS" node -e "
  const p = JSON.stringify({ peerId: process.env.PEER, hints: JSON.parse(process.env.ADDRS) });
  process.stdout.write(p);
")

daemon_exec registerLocationHints "$HINTS_PARAMS" >/dev/null
ok "Location hints registered for peer $HOME_PEER_ID"

# ---------------------------------------------------------------------------
# 5. Launch wallet subcluster
# ---------------------------------------------------------------------------

info "Launching wallet subcluster..."

# Extract RPC host (including port) for allowedHosts.
# new URL(url).host includes the port for non-default ports (e.g. "evm:8545").
AWAY_RPC_HOST=""
if [[ -n "$CUSTOM_RPC_URL" ]]; then
  AWAY_RPC_HOST=$(echo "$CUSTOM_RPC_URL" | node -e "
    const u = require('fs').readFileSync('/dev/stdin','utf8').trim();
    try { process.stdout.write(new URL(u).host); } catch {}
  ")
elif [[ -n "$INFURA_KEY" ]]; then
  AWAY_RPC_HOST=$(echo "$(infura_rpc_url "$CHAIN_ID" "x")" | node -e "
    const u = require('fs').readFileSync('/dev/stdin','utf8').trim();
    try { process.stdout.write(new URL(u).host); } catch {}
  ")
fi

CONFIG=$(BUNDLE_DIR="$BUNDLE_DIR" RPC_HOST="$AWAY_RPC_HOST" node -e "
  const bd = process.env.BUNDLE_DIR;
  const rpcHost = process.env.RPC_HOST;
  const extra = (process.env.EXTRA_ALLOWED_HOSTS || '').split(',').filter(Boolean);
  const hosts = [rpcHost, 'api.pimlico.io', 'swap.api.cx.metamask.io', ...extra].filter(Boolean);
  const config = {
    config: {
      bootstrap: 'coordinator',
      forceReset: true,
      services: ['ocapURLIssuerService', 'ocapURLRedemptionService'],
      vats: {
        coordinator: {
          bundleSpec: bd + '/away-coordinator.bundle',
          globals: ['Date', 'setTimeout']
        },
        keyring: {
          bundleSpec: bd + '/keyring-vat.bundle',
          globals: ['crypto']
        },
        provider: {
          bundleSpec: bd + '/provider-vat.bundle',
          globals: ['fetch', 'Request', 'Headers', 'Response'],
          network: { allowedHosts: hosts }
        },
        redeemer: {
          bundleSpec: bd + '/redeemer-vat.bundle',
          globals: []
        }
      }
    }
  };
  process.stdout.write(JSON.stringify(config));
")

LAUNCH_RESULT=$(node "$OCAP_BIN" daemon exec launchSubcluster "$CONFIG")
ROOT_KREF=$(echo "$LAUNCH_RESULT" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8').trim());
  process.stdout.write(data.rootKref);
")

if [[ -z "$ROOT_KREF" ]]; then
  fail "Failed to extract rootKref from launch result"
fi
ok "Subcluster launched — coordinator: $ROOT_KREF"

# ---------------------------------------------------------------------------
# 6. Initialize keyring (throwaway)
# ---------------------------------------------------------------------------

info "Initializing throwaway keyring..."
daemon_qm --quiet "$ROOT_KREF" initializeKeyring '[{"type":"throwaway"}]' >/dev/null
ok "Throwaway keyring initialized"

info "Verifying accounts..."
ACCOUNTS=$(daemon_qm "$ROOT_KREF" getAccounts)
ok "Local throwaway account: $ACCOUNTS"

# ---------------------------------------------------------------------------
# 7. Configure provider (optional — only if Infura key provided)
# ---------------------------------------------------------------------------

# Resolve the RPC URL: --rpc-url takes precedence, then Infura derivation
RPC_URL=""
if [[ -n "$CUSTOM_RPC_URL" ]]; then
  RPC_URL="$CUSTOM_RPC_URL"
elif [[ -n "$INFURA_KEY" ]]; then
  RPC_URL=$(infura_rpc_url "$CHAIN_ID" "$INFURA_KEY") || exit 1
fi

if [[ -n "$RPC_URL" ]]; then
  info "Configuring provider (chain $CHAIN_ID)..."

  PROVIDER_ARGS=$(CID="$CHAIN_ID" URL="$RPC_URL" node -e "
    process.stdout.write(JSON.stringify([{ chainId: Number(process.env.CID), rpcUrl: process.env.URL }]));
  ")

  daemon_qm "$ROOT_KREF" configureProvider "$PROVIDER_ARGS" >/dev/null
  ok "Provider configured — $RPC_URL"
fi

# ---------------------------------------------------------------------------
# 7b. Configure bundler (requires Pimlico key)
# ---------------------------------------------------------------------------

if [[ -n "$PIMLICO_KEY" ]]; then
  PIMLICO_BASE=$(pimlico_rpc_url "$CHAIN_ID") || exit 1
  BUNDLER_URL="${PIMLICO_BASE}?apikey=${PIMLICO_KEY}"
  info "Configuring bundler (Pimlico)..."

  BUNDLER_ARGS=$(CID="$CHAIN_ID" BURL="$BUNDLER_URL" node -e "
    process.stdout.write(JSON.stringify([{ bundlerUrl: process.env.BURL, chainId: Number(process.env.CID), usePaymaster: true }]));
  ")

  daemon_qm "$ROOT_KREF" configureBundler "$BUNDLER_ARGS" >/dev/null
  ok "Bundler configured — Pimlico (chain $CHAIN_ID)"

  # Create a Hybrid smart account (counterfactual — no on-chain tx needed).
  # It deploys automatically on the first UserOp via factory data.
  # The away device can't use stateless7702 because the throwaway EOA has
  # no ETH to pay for the on-chain EIP-7702 authorization tx.
  info "Setting up smart account (Hybrid, counterfactual)..."
  SA_ARGS=$(CID="$CHAIN_ID" node -e "
    process.stdout.write(JSON.stringify([{ chainId: Number(process.env.CID) }]));
  ")
  SA_RESULT=$(daemon_qm "$ROOT_KREF" createSmartAccount "$SA_ARGS" --timeout 120)
  SMART_ACCOUNT=$(echo "$SA_RESULT" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(d.address || '');
  " 2>/dev/null || echo "")
  if [[ -n "$SMART_ACCOUNT" ]]; then
    ok "Smart account: $SMART_ACCOUNT (deploys on first UserOp)"
  else
    info "Smart account creation returned no address — redemption may not work"
  fi
else
  info "Skipping bundler config (no --pimlico-key). Delegation redemptions will be relayed to the home wallet (requires home online)."
fi

# ---------------------------------------------------------------------------
# 8. Connect to home wallet
# ---------------------------------------------------------------------------

info "Connecting to home wallet..."

CONNECT_ARGS=$(PEER_URL="$OCAP_URL" node -e "
  process.stdout.write(JSON.stringify([process.env.PEER_URL]));
")

daemon_qm "$ROOT_KREF" connectToPeer "$CONNECT_ARGS" --timeout 120 >/dev/null

# ---------------------------------------------------------------------------
# 9. Wait for peer wallet connection
# ---------------------------------------------------------------------------

info "Waiting for peer wallet connection (up to 60s)..."
for i in $(seq 1 60); do
  CAPS_RESULT=$(daemon_qm --quiet "$ROOT_KREF" getCapabilities 2>/dev/null) || CAPS_RESULT=""
  if [[ -n "$CAPS_RESULT" ]]; then
    HAS_PEER=$(echo "$CAPS_RESULT" | node -e "
      try {
        const v = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8').trim());
        process.stdout.write(String(v.hasPeerWallet));
      } catch { process.stdout.write('false'); }
    " 2>/dev/null || echo "false")
    if [[ "$HAS_PEER" == "true" ]]; then
      break
    fi
  fi
  if [[ "$i" -eq 60 ]]; then
    fail "Peer wallet not connected after 60s"
  fi
  sleep 1
done
ok "Peer wallet connected and verified"

# ---------------------------------------------------------------------------
# 9b. Cache peer accounts for offline autonomy
# ---------------------------------------------------------------------------

info "Caching home device accounts for offline use..."
CACHED_ACCOUNTS=$(daemon_qm "$ROOT_KREF" refreshPeerAccounts)
ok "Cached peer accounts: $CACHED_ACCOUNTS"

# ---------------------------------------------------------------------------
# 10. Delegate authority (interactive)
# ---------------------------------------------------------------------------

# Use the smart account as delegate if available, otherwise the throwaway EOA
if [[ -n "${SMART_ACCOUNT:-}" ]]; then
  DELEGATE_ADDR="$SMART_ACCOUNT"
else
  DELEGATE_ADDR=$(echo "$ACCOUNTS" | node -e "
    const arr = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(arr[0]);
  ")
fi

# ---------------------------------------------------------------------------
# 9c. Send delegate address to home device
# ---------------------------------------------------------------------------

info "Sending delegate address to home device..."
if daemon_qm --quiet "$ROOT_KREF" sendDelegateAddressToPeer "[\"$DELEGATE_ADDR\"]" --timeout 15 >/dev/null 2>&1; then
  ok "Delegate address sent to home device: $DELEGATE_ADDR"
else
  echo -e "  ${YELLOW}Could not send delegate address automatically.${RESET}" >&2
fi

cat >&2 <<EOF

$(echo -e "${GREEN}${BOLD}")══════════════════════════════════════════════
  Away wallet ready — waiting for delegation
══════════════════════════════════════════════$(echo -e "${RESET}")

  $(echo -e "${DIM}")Coordinator kref :$(echo -e "${RESET}") $ROOT_KREF
  $(echo -e "${DIM}")Chain ID         :$(echo -e "${RESET}") $CHAIN_ID
  $(echo -e "${DIM}")Delegate address :$(echo -e "${RESET}") $DELEGATE_ADDR
  $(echo -e "${DIM}")Peer connected   :$(echo -e "${RESET}") $(echo -e "${GREEN}")true$(echo -e "${RESET}")

  $(echo -e "${DIM}")Run setup-home.sh on the home device now.$(echo -e "${RESET}")
  $(echo -e "${DIM}")The delegate address and delegation will be exchanged automatically.$(echo -e "${RESET}")

EOF

if [[ "$NON_INTERACTIVE" == true ]]; then
  info "Non-interactive mode — skipping delegation wait"
  DEL_COUNT="0"
  MANUAL_SKIP=false
else
  info "Waiting for delegation from home device (up to 10 min)..."
  echo -e "  ${DIM}Press Enter to skip waiting and paste manually.${RESET}" >&2

  DEL_COUNT="0"
  POLL_FAILURES=0
  MANUAL_SKIP=false
  for i in $(seq 1 300); do
    CAPS_RAW=$(daemon_exec --quiet queueMessage "[\"$ROOT_KREF\", \"getCapabilities\", []]" 2>/dev/null) || CAPS_RAW=""
    if [[ -n "$CAPS_RAW" ]]; then
      POLL_FAILURES=0
      DEL_COUNT=$(echo "$CAPS_RAW" | node -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8').trim());
        const v = JSON.parse(d.body.slice(1));
        process.stdout.write(String(v.delegationCount));
      " 2>/dev/null || echo "0")
      if [[ "$DEL_COUNT" != "0" ]]; then
        ok "Delegation received (auto-pushed from home device)"
        break
      fi
    else
      POLL_FAILURES=$((POLL_FAILURES + 1))
      if [[ "$POLL_FAILURES" -ge 5 ]]; then
        fail "Daemon appears to be down (5 consecutive failed polls). Check: tail -f ${OCAP_HOME:-~/.ocap}/daemon.log"
      fi
    fi
    if [[ "$i" -eq 300 ]]; then
      MANUAL_SKIP=true
      break
    fi
    # read -t 2 doubles as the sleep — pressing Enter skips to manual paste
    if read -t 2 -r _ 2>/dev/null; then
      MANUAL_SKIP=true
      break
    fi
  done
fi

if [[ "$MANUAL_SKIP" == true && "$DEL_COUNT" == "0" ]]; then
  echo "" >&2
  if [[ "$i" -eq 300 ]]; then
    echo -e "  ${YELLOW}Timed out waiting. Falling back to manual paste.${RESET}" >&2
  fi
  echo -e "${CYAN}→${RESET} Paste the delegation JSON from the home device (press Ctrl+D when done):" >&2
  DELEGATION_JSON=$(cat)

  if [[ -z "$DELEGATION_JSON" ]]; then
    fail "No delegation JSON provided"
  fi

  # Accept both CapData format (from old CLI) and plain JSON (from new CLI)
  DELEGATION_INNER=$(echo "$DELEGATION_JSON" | node -e "
    const raw = require('fs').readFileSync('/dev/stdin', 'utf8').trim();
    let data;
    try { data = JSON.parse(raw); } catch {
      process.stderr.write('Invalid JSON\n');
      process.exit(1);
    }
    if (data.body && typeof data.body === 'string' && data.body.startsWith('#')) {
      try {
        const inner = JSON.parse(data.body.slice(1));
        process.stdout.write(JSON.stringify(inner));
      } catch {
        process.stderr.write('Failed to parse CapData body\n');
        process.exit(1);
      }
    } else {
      process.stdout.write(JSON.stringify(data));
    }
  ")

  info "Receiving delegation..."
  RECEIVE_ARGS=$(DEL="$DELEGATION_INNER" node -e "
    process.stdout.write(JSON.stringify([JSON.parse(process.env.DEL)]));
  ")
  daemon_qm "$ROOT_KREF" receiveDelegation "$RECEIVE_ARGS" >/dev/null
  ok "Delegation received (manual)"

  CAPS_FINAL=$(daemon_qm --quiet "$ROOT_KREF" getCapabilities 2>/dev/null) || CAPS_FINAL=""
  DEL_COUNT=$(echo "$CAPS_FINAL" | node -e "
    try {
      const v = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8').trim());
      process.stdout.write(String(v.delegationCount));
    } catch { process.stdout.write('0'); }
  " 2>/dev/null || echo "0")
fi
ok "Delegation count: $DEL_COUNT"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

cat >&2 <<EOF

$(echo -e "${GREEN}${BOLD}")══════════════════════════════════════════════
  Away wallet setup complete!
══════════════════════════════════════════════$(echo -e "${RESET}")

  $(echo -e "${DIM}")Coordinator kref :$(echo -e "${RESET}") $ROOT_KREF
  $(echo -e "${DIM}")Delegate address :$(echo -e "${RESET}") $DELEGATE_ADDR
  $(echo -e "${DIM}")Delegations      :$(echo -e "${RESET}") $DEL_COUNT
  $(echo -e "${DIM}")Cached accounts  :$(echo -e "${RESET}") $CACHED_ACCOUNTS
  $(echo -e "${DIM}")Peer connected   :$(echo -e "${RESET}") $(echo -e "${GREEN}")true$(echo -e "${RESET}")

  Watch daemon logs: $(echo -e "${DIM}")tail -f ${OCAP_HOME:-~/.ocap}/daemon.log$(echo -e "${RESET}")
  Stop the daemon:   $(echo -e "${DIM}")yarn ocap daemon stop$(echo -e "${RESET}")
  Purge all state:   $(echo -e "${DIM}")yarn ocap daemon purge --force$(echo -e "${RESET}")

EOF

# ---------------------------------------------------------------------------
# 11. Optional: Install OpenClaw plugin
# ---------------------------------------------------------------------------

if command -v openclaw &>/dev/null; then
  INSTALL_PLUGIN="n"
  if [[ "$NON_INTERACTIVE" == true ]]; then
    INSTALL_PLUGIN="y"
  else
    echo "" >&2
    echo -ne "${CYAN}→${RESET} Install the OpenClaw wallet plugin? [y/N] " >&2
    read -r INSTALL_PLUGIN
  fi
  if [[ "$INSTALL_PLUGIN" =~ ^[Yy]$ ]]; then
    info "Installing OpenClaw wallet plugin..."
    (cd "$REPO_ROOT" && openclaw plugins install -l ./packages/evm-wallet-experiment/openclaw-plugin) >&2
    openclaw plugins enable wallet >&2
    openclaw config set plugins.allow '["wallet"]' >&2
    openclaw config set tools.allow '["wallet"]' >&2
    openclaw gateway restart >&2
    ok "OpenClaw wallet plugin installed and enabled"
    echo -e "  ${DIM}Run 'openclaw plugins list' to verify${RESET}" >&2
  else
    echo "" >&2
    echo -e "  ${DIM}To install manually later:${RESET}" >&2
    echo -e "  ${DIM}  cd $REPO_ROOT${RESET}" >&2
    echo -e "  ${DIM}  openclaw plugins install -l ./packages/evm-wallet-experiment/openclaw-plugin${RESET}" >&2
    echo -e "  ${DIM}  openclaw plugins enable wallet${RESET}" >&2
    echo -e "  ${DIM}  openclaw config set plugins.allow '[\"wallet\"]'${RESET}" >&2
    echo -e "  ${DIM}  openclaw config set tools.allow '[\"wallet\"]'${RESET}" >&2
    echo -e "  ${DIM}  openclaw gateway restart${RESET}" >&2
  fi
else
  echo "" >&2
  echo -e "  ${DIM}OpenClaw not found. To install the wallet plugin manually:${RESET}" >&2
  echo -e "  ${DIM}  cd $REPO_ROOT${RESET}" >&2
  echo -e "  ${DIM}  openclaw plugins install -l ./packages/evm-wallet-experiment/openclaw-plugin${RESET}" >&2
  echo -e "  ${DIM}  openclaw plugins enable wallet${RESET}" >&2
  echo -e "  ${DIM}  openclaw config set plugins.allow '[\"wallet\"]'${RESET}" >&2
  echo -e "  ${DIM}  openclaw config set tools.allow '[\"wallet\"]'${RESET}" >&2
  echo -e "  ${DIM}  openclaw gateway restart${RESET}" >&2
fi
