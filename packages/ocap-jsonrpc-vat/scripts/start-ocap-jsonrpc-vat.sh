#!/usr/bin/env bash
# Launch the ocap JSON-RPC subcluster in a local ocap daemon.
#
# The vat exposes a line-delimited JSON-RPC 2.0 interface on a
# Unix-domain socket under the daemon's home directory. Its two
# methods — `redeemURL(url)` and `send(target,method,args)` — are
# intended as the routine path by which local, non-vat processes
# reach kernel objects, replacing ad-hoc use of the kernel-cli's
# `queueMessage` RPC.
#
# The target daemon is chosen by (in order):
#   1. --home <dir>      (explicit override on the CLI)
#   2. $OCAP_HOME        (environment variable)
#   3. ~/.ocap           (default)
# The vat's socket lives at <home>/ocap-jsonrpc.sock.
#
# Prerequisites: the target daemon must already be running and have
# `ocapURLRedemptionService` available (i.e. remote comms initialised
# if you plan to redeem URLs pointing at other peers).
#
# Usage:
#   start-ocap-jsonrpc-vat.sh [--home DIR] [--no-build] [--force-reset]

set -euo pipefail

SKIP_BUILD=false
FORCE_RESET=false
OCAP_HOME_ARG=""

usage() {
  cat >&2 <<EOF
Usage: $0 [--home DIR] [--no-build] [--force-reset]

  --home DIR     Target daemon's home directory. Overrides \$OCAP_HOME
                 and the ~/.ocap default. The vat's socket is created
                 at <home>/ocap-jsonrpc.sock.
  --no-build     Skip building/bundling the ocap JSON-RPC vat.
  --force-reset  Force-reset the subcluster if one already exists.
                 Without this, an existing subcluster is reused as-is.
  --help, -h     Show this help.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)
      [[ $# -lt 2 ]] && { echo "Error: --home requires a value" >&2; usage; }
      OCAP_HOME_ARG="$2"; shift 2 ;;
    --no-build) SKIP_BUILD=true; shift ;;
    --force-reset) FORCE_RESET=true; shift ;;
    --help|-h) usage ;;
    *) echo "Error: unknown argument: $1" >&2; usage ;;
  esac
done

info() { echo "[start-ocap-jsonrpc-vat] $*" >&2; }
fail() { echo "[start-ocap-jsonrpc-vat] ERROR: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
OCAP_BIN="$REPO_ROOT/packages/kernel-cli/dist/app.js"
BUNDLE_FILE="$PKG_DIR/src/vat/index.bundle"

OCAP_HOME_DIR="${OCAP_HOME_ARG:-${OCAP_HOME:-${HOME}/.ocap}}"
SOCKET_PATH="$OCAP_HOME_DIR/ocap-jsonrpc.sock"

if [[ ! -f "$OCAP_BIN" ]]; then
  fail "ocap CLI not found at $OCAP_BIN. Run \`yarn workspace @metamask/kernel-cli build\` first."
fi

if $SKIP_BUILD; then
  info "Skipping build (--no-build)"
  [[ -f "$BUNDLE_FILE" ]] || fail "Bundle not found at $BUNDLE_FILE. Remove --no-build or build first."
else
  info "Building ocap-jsonrpc-vat package..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/ocap-jsonrpc-vat build >&2)
  info "Bundling vat..."
  (cd "$REPO_ROOT" && yarn workspace @ocap/ocap-jsonrpc-vat bundle-vat >&2)
fi

# All CLI invocations against this daemon go through this wrapper so
# they use the requested home rather than the CLI default.
daemon_cli() {
  (cd "$REPO_ROOT" && node "$OCAP_BIN" --home "$OCAP_HOME_DIR" "$@")
}

# Fast-fail if the daemon isn't up.
if ! daemon_cli daemon exec getStatus >/dev/null 2>&1; then
  fail "daemon at $OCAP_HOME_DIR does not respond to \`daemon exec getStatus\`. Start it first."
fi

# Look up any existing subcluster: reuse it, unless --force-reset was
# passed — in which case terminate it first so we can launch a fresh
# one (kernel state stays, the vat's baggage and @@ name counter go).
EXISTING_ID=$(daemon_cli daemon exec getStatus | node -e "
  const raw = require('fs').readFileSync('/dev/stdin','utf8').trim();
  const data = JSON.parse(raw);
  const subclusters = data.subclusters ?? [];
  const found = subclusters.find(
    (sc) => sc?.config?.bootstrap === 'ocapJsonrpcVat',
  );
  if (found) {
    process.stdout.write(found.id);
  }
")

if [[ -n "$EXISTING_ID" ]]; then
  if [[ "$FORCE_RESET" == "true" ]]; then
    info "Terminating existing subcluster $EXISTING_ID before relaunch..."
    daemon_cli daemon exec terminateSubcluster "$(node -e \
      "process.stdout.write(JSON.stringify({id: process.argv[1]}))" \
      "$EXISTING_ID")" >/dev/null \
      || fail "terminateSubcluster $EXISTING_ID failed"
    # Give the kernel a moment to tear down the IO channel.
    sleep 0.3
  else
    info "Subcluster already exists ($EXISTING_ID); reusing."
    if [[ ! -S "$SOCKET_PATH" ]]; then
      fail "Existing subcluster claims to be up but socket $SOCKET_PATH is missing."
    fi
    info "Home:   $OCAP_HOME_DIR"
    info "Socket: $SOCKET_PATH"
    echo "socket: $SOCKET_PATH"
    exit 0
  fi
fi

CONFIG=$(BUNDLE="file://$BUNDLE_FILE" \
         SOCKET="$SOCKET_PATH" \
         node -e "
  const config = {
    config: {
      bootstrap: 'ocapJsonrpcVat',
      services: ['ocapURLRedemptionService'],
      io: {
        socket: { type: 'socket', path: process.env.SOCKET }
      },
      vats: {
        ocapJsonrpcVat: { bundleSpec: process.env.BUNDLE }
      }
    }
  };
  process.stdout.write(JSON.stringify(config));
")

info "Launching subcluster in $OCAP_HOME_DIR..."
daemon_cli daemon exec launchSubcluster "$CONFIG" >/dev/null

# Give the vat a moment to open its listener before reporting readiness.
for i in $(seq 1 20); do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  if [[ "$i" -eq 20 ]]; then
    fail "Socket $SOCKET_PATH did not appear after 2s. See daemon logs."
  fi
  sleep 0.1
done

info "Vat ready."
info "Home:   $OCAP_HOME_DIR"
info "Socket: $SOCKET_PATH"
echo "socket: $SOCKET_PATH"
