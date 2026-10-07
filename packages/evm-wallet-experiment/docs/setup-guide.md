# EVM Wallet Setup Guide

This guide walks through setting up the OCAP evm-wallet on two devices:

- **Home device** (your laptop/desktop): holds the master keys, approves signing requests
- **Away device** (VPS): runs the agent with a restricted wallet, uses delegations

**Contents:**

- [API keys](#api-keys) — Infura, Pimlico, and testnet ETH
- [Ports and firewall](#ports-and-firewall) — what to open on the VPS
- [Quick start](#quick-start-automated-scripts) — automated setup scripts
- [Spending limits](#spending-limits) — restrict how much ETH the agent can spend
- [OpenClaw plugin install](#openclaw-plugin-install) — configure the agent plugin
- [Manual setup](#manual-setup) — step-by-step commands
  - [1. Build the packages](#1-build-the-packages)
  - [2. Home device setup](#2-home-device-setup)
  - [3. Away device setup](#3-away-device-vps-setup)
  - [4. Delegate authority](#4-delegate-authority-from-home-to-away)
- [Try it out](#5-try-it-out) — agent prompts and CLI commands
- [How it works](#6-how-it-works)
- [Verify everything works](#7-verify-everything-works)

## Prerequisites

- Node.js >= 22
- yarn (`npm install -g yarn` or enable via `corepack enable`)
- The `ocap-kernel` monorepo cloned and built

```bash
git clone https://github.com/Consensys-Incorporated/ocap-kernel.git
```

- OpenClaw installed on the VPS (for the agent integration)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

- (Optional) Connect a Telegram channel to interact with the agent via chat. Follow the setup instructions at <https://docs.openclaw.ai/channels/telegram>.

## API keys

### Infura (Ethereum RPC)

1. Go to <https://developer.metamask.io>
2. Sign in with Google and create a free account
3. You should land on the dashboard with a "My First Key" visible — click the **Copy key** button on the right

### Pimlico (ERC-4337 bundler + paymaster)

1. Go to <https://dashboard.pimlico.io> and create an account
2. Generate an API key for your target chain (e.g. **sepolia-testnet** for testing, or a mainnet chain)
3. Go to <https://dashboard.pimlico.io/sponsorship-policies>, add an "allow all" policy, and enable it

### Testnet ETH (Sepolia only)

If using Sepolia for testing, the home wallet's mnemonic account needs a small amount of Sepolia ETH for gas. You can get free testnet ETH from:

- <https://docs.metamask.io/developer-tools/faucet> (MetaMask / Infura faucet)
- <https://sepolia-faucet.pk910.de/> (PoW faucet, no sign-in required)

For mainnet chains, the home wallet needs a small amount of native tokens for gas (ETH, MATIC, BNB, etc.).

## Ports and firewall

The home and away kernels communicate over libp2p. There are two networking modes; choose whichever matches your network topology.

### Direct mode (both devices have public IPs)

Both devices dial each other directly over QUIC (UDP). One port is needed on each device:

| Device | Port     | Protocol | Purpose                 |
| ------ | -------- | -------- | ----------------------- |
| Home   | 4002/udp | QUIC     | libp2p direct transport |
| VPS    | 4002/udp | QUIC     | libp2p direct transport |

```bash
# On each device
sudo ufw allow 4002/udp
```

The port is configurable via `--quic-port` in the setup scripts. No relay is needed; pass no `--relay` flag.

### Relay mode (home is behind NAT / CGN / DS-Lite)

If the home device has no public IPv4 (common with CGN/DS-Lite), both kernels connect **outbound** to a relay running on the VPS. No inbound ports are needed on the home device.

| Device | Port     | Protocol  | Purpose                                                                                         |
| ------ | -------- | --------- | ----------------------------------------------------------------------------------------------- |
| VPS    | 9001/tcp | WebSocket | Relay listener (kernels dial this)                                                              |
| VPS    | 9002/tcp | TCP       | Relay listener (alternative transport)                                                          |
| VPS    | 4002/udp | QUIC      | VPS kernel's own direct listener (optional — needed if other peers connect directly to the VPS) |
| Home   | _none_   | —         | All connections are outbound                                                                    |

```bash
# On the VPS
sudo ufw allow 9001/tcp   # relay WebSocket
sudo ufw allow 9002/tcp   # relay TCP
sudo ufw allow 4002/udp   # QUIC (if direct peers also connect)
```

### Outbound access (both modes)

Both devices need outbound HTTPS (TCP 443) to:

- **Infura** (`<chain>.infura.io`, e.g. `mainnet.infura.io`, `sepolia.infura.io`) — Ethereum JSON-RPC. The exact subdomain depends on the chain. If using `--rpc-url` with a custom provider, substitute that host instead.
- **Pimlico** (`api.pimlico.io`) — ERC-4337 bundler and paymaster
- **MetaMask Swaps** (`swap.api.cx.metamask.io`) — Token swap quotes and trades (only needed if using swap tools)

No special firewall rules are needed for outbound on most systems.

## Quick start (automated scripts)

There are two home-device modes, plus a shared away-device script:

| Script                      | Mode                       | Signing                                                                  | Key storage                                                      |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `setup-home.sh`             | **Mnemonic**               | Automatic (no approval)                                                  | Mnemonic on home device (optionally encrypted with `--password`) |
| `setup-home-interactive.sh` | **Interactive (MetaMask)** | MetaMask Mobile signs the delegation once during setup; autonomous after | No keys on home device                                           |
| `setup-away.sh`             | Away device                | Via peer wallet to home                                                  | Throwaway key only                                               |

Both home scripts produce the same output (OCAP URL, listen addresses, delegation JSON) and the away script works identically with either.

### Using a relay (recommended)

If your home device is behind CGN/DS-Lite (no public IPv4), you need a relay. Start one on the VPS:

```bash
yarn ocap relay
# Note the PeerID and multiaddrs (WebSocket port 9001, TCP port 9002)
```

To run the relay as a systemd service (recommended for VPS deployments):

```bash
sudo tee /etc/systemd/system/ocap-relay.service > /dev/null <<'UNIT'
[Unit]
Description=OCAP libp2p relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/ocap-kernel
ExecStart=/root/.nvm/versions/node/v24.14.0/bin/node packages/kernel-cli/dist/app.mjs relay
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now ocap-relay
```

Adjust `User`, `WorkingDirectory`, and the node path to match your setup. Manage with `systemctl status/restart/stop ocap-relay` and view logs with `journalctl -u ocap-relay -f`.

The relay PeerID is deterministic: `12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc`. Form the relay address using the VPS's public IP and the **WebSocket** port (the kernel dials via WebSocket):

```
/ip4/<VPS_PUBLIC_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc
```

Pass `--relay` to both setup scripts (see below). Both devices connect **outbound** to the relay — no inbound ports needed on the home device.

### Direct connection (both devices have public IPs)

If both devices have public IPs (no CGN), they can connect directly over QUIC (UDP). See the [Ports and firewall](#ports-and-firewall) section above.

No `--relay` flag is needed in this case.

### Switching between relay and direct mode

Relay addresses are persisted in the kernel's KV store. If you previously ran with `--relay` and want to switch to direct mode (or vice versa), purge the daemon state first:

```bash
yarn ocap daemon stop
yarn ocap daemon purge --force
```

Then re-run the setup script. Without this, the old relay address stays embedded in new OCAP URLs.

### Step 1 — Start the home script

Choose one of the two modes:

#### Option A: Mnemonic mode (automatic signing)

```bash
# Sepolia (default chain):
./packages/evm-wallet-experiment/scripts/setup-home.sh \
  --mnemonic "your twelve word mnemonic" \
  --infura-key YOUR_INFURA_KEY \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"

# Base mainnet:
./packages/evm-wallet-experiment/scripts/setup-home.sh \
  --mnemonic "your twelve word mnemonic" \
  --chain base \
  --infura-key YOUR_INFURA_KEY \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"

# BNB Smart Chain (no Infura — use custom RPC):
./packages/evm-wallet-experiment/scripts/setup-home.sh \
  --mnemonic "your twelve word mnemonic" \
  --chain bsc \
  --rpc-url "https://bsc-dataseed.binance.org" \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"
```

To encrypt the mnemonic at rest, add `--password`:

```bash
./packages/evm-wallet-experiment/scripts/setup-home.sh \
  --mnemonic "your twelve word mnemonic" \
  --password "your-password" \
  --infura-key YOUR_INFURA_KEY \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"
```

The script sets up the home wallet and then **waits** — it will show the OCAP URL and listen addresses to copy.

#### Option B: Interactive mode (MetaMask)

No mnemonic needed — MetaMask Mobile handles signing during setup. MetaMask approval is only required once: to sign the delegation. After that the away device acts autonomously.

```bash
./packages/evm-wallet-experiment/scripts/setup-home-interactive.sh \
  --infura-key YOUR_INFURA_KEY \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"

# Or for a specific chain:
./packages/evm-wallet-experiment/scripts/setup-home-interactive.sh \
  --chain base \
  --infura-key YOUR_INFURA_KEY \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"
```

The script will:

1. Show a QR code — scan it with MetaMask Mobile to connect
2. Switch MetaMask to the target chain
3. Start an in-process kernel (no daemon — the MetaMask signer is a live object)
4. Create a Hybrid smart account and fund it if needed (may trigger a MetaMask approval for the funding tx)
5. Show the OCAP URL and `setup-away.sh` command

Use `--reset` to purge all kernel state and start fresh. The SQLite database is at `$OCAP_HOME/kernel-interactive.sqlite` (defaults to `~/.ocap/kernel-interactive.sqlite`).

**Note:** Interactive mode uses a Hybrid smart account (different address from the EOA) instead of EIP-7702 stateless. This is because EIP-7702 requires signing an authorization transaction that MetaMask Mobile does not support. The smart account is auto-funded from the EOA if its balance is below 0.05 ETH.

### Step 2 — Start the away script (on the VPS)

The home script outputs a complete `setup-away.sh` command with all flags pre-filled. Copy and paste it on the VPS (from the `ocap-kernel` repo root):

```bash
# Example output from setup-home.sh — copy the whole command
./packages/evm-wallet-experiment/scripts/setup-away.sh \
  --ocap-url "ocap:…URL_FROM_HOME…" \
  --listen-addrs '["/ip4/…/udp/…/quic-v1/p2p/…"]' \
  --infura-key YOUR_INFURA_KEY \
  --pimlico-key YOUR_PIMLICO_KEY \
  --relay "/ip4/<VPS_IP>/tcp/9001/ws/p2p/12D3KooWJBDqsyHQF2MWiCdU4kdqx4zTsSTLRdShg7Ui6CRWB4uc"
```

When the away script finishes setup, it shows the **delegate address** and waits.

### Step 3 — Delegate authority (automatic)

The delegate address and delegation are exchanged automatically over the QUIC/CapTP connection — no copy-paste needed:

1. The away script connects to the home kernel, and the setup flow sends its delegate address automatically
2. The home script detects the delegate address, prompts for spending limits, creates the delegation, and pushes it to the away device over QUIC
3. The away script receives the delegation and verifies it

Both scripts finish automatically after the delegation is transferred. If the automatic exchange fails (e.g. network issues), both scripts fall back to manual input — you can paste the delegate address or delegation JSON when prompted, or press Enter to skip to the manual prompt at any time.

> **Offline autonomy:** After the delegation is received, the away device caches the home accounts and operates fully autonomously. The home device can go offline — the VPS will continue sending ETH, signing messages, and responding to agent requests without it. See [How It Works — Offline Autonomy](./how-it-works.md#offline-autonomy-vps-mode) for details.

During delegation setup, the home script prompts for two optional spending limits:

- **Total ETH spending limit** — the maximum cumulative ETH the agent can spend across all transactions (enforced by the `NativeTokenTransferAmountEnforcer`)
- **Max ETH per transaction** — the maximum ETH value in any single transaction (enforced by the `ValueLteEnforcer`)

Both limits are enforced on-chain by caveat enforcers in the DeleGator framework. The agent cannot bypass them. Press Enter at either prompt to skip that limit.

The `--pimlico-key` configures the Pimlico bundler for ERC-4337 UserOp submission with paymaster sponsorship. It is **optional** for the away device: with it, the away wallet submits its own UserOps autonomously (Hybrid smart account, offline-capable); without it, delegation redemptions are relayed to the home wallet via CapTP (requires the home wallet to be online). It is required for any **Hybrid** home setup. For a **mnemonic home wallet using stateless EIP-7702** (`implementation: 'stateless7702'`), delegation redemption uses your normal RPC only — Pimlico is optional on the home device in that configuration.

All scripts also accept `--chain <name>` (e.g. `--chain base`, `--chain ethereum`) or `--chain-id <number>` (default: Sepolia 11155111), `--quic-port` (default: 4002), and `--no-build`. For chains not supported by Infura (e.g. BNB Smart Chain), pass `--rpc-url` instead of `--infura-key`. Run with `--help` for details.

Supported chain names and aliases:

| Name     | Chain ID | Aliases      |
| -------- | -------- | ------------ |
| ethereum | 1        | eth, mainnet |
| optimism | 10       | op           |
| bsc      | 56       | bnb          |
| polygon  | 137      | matic        |
| base     | 8453     |              |
| arbitrum | 42161    | arb          |
| linea    | 59144    |              |
| sepolia  | 11155111 |              |

`setup-away.sh` will offer to install the OpenClaw plugin automatically at the end. If you decline, it prints the manual install commands.

## Spending limits

The delegation can include on-chain spending limits that restrict how much ETH the agent is allowed to spend. Two types of limits are available:

| Limit                  | Enforcer contract                   | Address (same on all chains)                 |
| ---------------------- | ----------------------------------- | -------------------------------------------- |
| Total spending ceiling | `NativeTokenTransferAmountEnforcer` | `0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320` |
| Per-transaction max    | `ValueLteEnforcer`                  | `0x92Bf12322527cAA612fd31a0e810472BBB106A8F` |

Both limits compose — the DelegationManager checks ALL caveats, so both must pass for a transaction to go through.

### Setting limits (automated scripts)

The `setup-home.sh` script prompts for both limits during delegation creation:

```
→ Total ETH spending limit (e.g. 0.1, or Enter for unlimited):
→ Max ETH per transaction (e.g. 0.01, or Enter for unlimited):
```

### Setting limits (manual)

When creating a delegation manually, add caveats to the `caveats` array. The `terms` field is `abi.encode(uint256)` — the amount in wei, padded to 32 bytes:

```bash
# Delegation with 0.05 ETH total limit and 0.01 ETH per-transaction limit
yarn ocap daemon queueMessage ko4 createDelegation '[{
  "delegate": "0xAWAY_SMART_ACCOUNT",
  "caveats": [
    {
      "type": "nativeTokenTransferAmount",
      "enforcer": "0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320",
      "terms": "0x0000000000000000000000000000000000000000000000000000b1a2bc2ec500"
    },
    {
      "type": "valueLte",
      "enforcer": "0x92Bf12322527cAA612fd31a0e810472BBB106A8F",
      "terms": "0x000000000000000000000000000000000000000000000000002386f26fc10000"
    }
  ],
  "chainId": 11155111
}]'
```

### Changing limits

Spending limits are immutable once set — they are baked into the delegation's cryptographic signature. To change limits, use the `update-limits.sh` script on the home device:

```bash
./packages/evm-wallet-experiment/scripts/update-limits.sh
```

This will:

1. Show your current active delegations and their limits
2. Prompt for new total and per-transaction limits
3. Revoke old delegations (on-chain via `DelegationManager.disableDelegation`)
4. Create and sign a new delegation (the cumulative spending counter resets to zero)
5. Push the new delegation to the away device over the existing QUIC/CapTP connection

If the away device is offline, the script falls back to printing a manual command to run on the away device.

## OpenClaw plugin install

Run this on the away device after `setup-away.sh` completes. The install path must be relative to the current directory (use `./`).

1. Link and enable the plugin:

```bash
openclaw plugins install -l ./packages/evm-wallet-experiment/openclaw-plugin
openclaw plugins enable wallet
```

2. Allow the plugin and its tools:

```bash
openclaw config set plugins.allow '["wallet"]'
openclaw config set tools.allow '["wallet"]'
```

3. Restart the gateway and verify the plugin loaded:

```bash
openclaw gateway restart
openclaw plugins list        # should show wallet as enabled
openclaw plugins doctor      # should report no errors
```

The plugin auto-detects the CLI path relative to the monorepo and defaults to `ko4` for the wallet coordinator kref. To override these defaults:

```bash
openclaw config set plugins.entries.wallet.config.walletKref '"ko8"'
openclaw config set plugins.entries.wallet.config.ocapCliPath '"/custom/path/to/ocap"'
```

The wallet tools (`wallet_balance`, `wallet_send`, `wallet_token_balance`, `wallet_token_send`, `wallet_token_info`, `wallet_token_resolve`, `wallet_swap`, `wallet_swap_quote`, `wallet_sign`, `wallet_accounts`, `wallet_capabilities`) are automatically available to agents once the plugin is enabled and allowed via `plugins.allow` and `tools.allow`.

---

## Manual setup

The sections below walk through each step if you prefer to run the commands yourself.

## 1. Build the packages

From the monorepo root:

```bash
yarn install
yarn workspace @metamask/ocap-kernel build
yarn workspace @metamask/kernel-node-runtime build
yarn workspace @metamask/kernel-cli build
yarn workspace @ocap/evm-wallet-experiment build
```

The last command produces four `.bundle` files in `packages/evm-wallet-experiment/src/vats/`.

## 2. Home device setup

The home device holds the master wallet keys and runs a kernel daemon that the away device can connect to.

### 2a. Start the home daemon

```bash
yarn ocap daemon start
```

This starts the OCAP daemon at `~/.ocap/daemon.sock` with persistent storage at `~/.ocap/kernel.sqlite`. You can override the `~/.ocap` base directory by setting the `OCAP_HOME` environment variable (e.g. `export OCAP_HOME=/data/ocap`).

### 2b. Initialize remote comms (QUIC)

Initialize the libp2p networking stack before launching the subcluster. The OCAP URL issuer service requires an active network identity.

```bash
# Start QUIC transport (use a fixed port so firewall rules work)
yarn ocap daemon exec initRemoteComms '{"directListenAddresses": ["/ip4/0.0.0.0/udp/4002/quic-v1"]}'

# Verify it's connected and note the listen addresses
yarn ocap daemon exec getStatus
# Look for: remoteComms.state === "connected", remoteComms.listenAddresses
```

Save the listen addresses — you'll give them to the away device along with the OCAP URL.

### 2c. Launch the wallet subcluster

```bash
yarn ocap daemon exec launchSubcluster '{
  "config": {
    "bootstrap": "coordinator",
    "forceReset": true,
    "services": ["ocapURLIssuerService", "ocapURLRedemptionService"],
    "vats": {
      "coordinator": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/home-coordinator.bundle",
        "globals": ["Date", "setTimeout"]
      },
      "keyring": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/keyring-vat.bundle",
        "globals": ["crypto"]
      },
      "provider": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/provider-vat.bundle",
        "globals": ["fetch", "Request", "Headers", "Response"],
        "network": { "allowedHosts": ["<chain>.infura.io", "api.pimlico.io", "swap.api.cx.metamask.io"] }
      },
      "delegator": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/delegator-vat.bundle",
        "globals": ["crypto"],
        "parameters": { "delegationManagerAddress": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" }
      }
    }
  }
}'
```

Note the `rootKref` from the output (e.g. `ko4`). This is the wallet coordinator reference. The CLI automatically converts absolute file paths to `file://` URLs.

> **Note:** Replace `<chain>.infura.io` in `allowedHosts` with the actual Infura subdomain for your chain (e.g. `mainnet.infura.io`, `base-mainnet.infura.io`, `sepolia.infura.io`). If using a custom RPC provider via `--rpc-url`, use that provider's hostname instead.

> **Warning:** `forceReset: true` destroys all existing subcluster state (keyrings, delegations, OCAP URLs). Omit it on subsequent runs to preserve state.

### 2d. Initialize the keyring

```bash
# Initialize with your mnemonic (SRP) — plaintext storage
yarn ocap daemon queueMessage ko4 initializeKeyring '[{"type": "srp", "mnemonic": "your twelve word mnemonic phrase here"}]'

# Or encrypt the mnemonic at rest with a password:
SALT="$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")"
yarn ocap daemon queueMessage ko4 initializeKeyring "[{\"type\": \"srp\", \"mnemonic\": \"your twelve word mnemonic phrase here\", \"password\": \"your-password\", \"salt\": \"$SALT\"}]"

# Verify
yarn ocap daemon queueMessage ko4 getAccounts
```

When a password is provided, the mnemonic is encrypted with AES-256-GCM (PBKDF2 key derivation). After a daemon restart, the keyring will be locked — unlock it before signing:

```bash
yarn ocap daemon queueMessage ko4 unlockKeyring '["your-password"]'
```

### 2e. Configure the provider

```bash
yarn ocap daemon queueMessage ko4 configureProvider '[{"chainId": 11155111, "rpcUrl": "https://sepolia.infura.io/v3/YOUR_INFURA_KEY"}]'
# For other chains, adjust chainId and rpcUrl:
# yarn ocap daemon queueMessage ko4 configureProvider '[{"chainId": 8453, "rpcUrl": "https://base-mainnet.infura.io/v3/YOUR_INFURA_KEY"}]'
```

### 2f. Issue an OCAP URL for the away device

```bash
yarn ocap daemon queueMessage ko4 issueOcapUrl
```

Save the returned `ocap:...` URL and the listen addresses from `getStatus` above — you'll give both to the away device.

## 3. Away device (VPS) setup

### 3a. Install OpenClaw

Follow the OpenClaw installation docs. The agent will use the wallet plugin to interact with the kernel.

### 3b. Start the away daemon

```bash
yarn ocap daemon start
```

### 3c. Initialize remote comms and register home location hints

```bash
# Start the libp2p networking stack with QUIC transport
# Use a fixed port and open it in the firewall: sudo ufw allow 4002/udp
yarn ocap daemon exec initRemoteComms '{"directListenAddresses": ["/ip4/0.0.0.0/udp/4002/quic-v1"]}'

# Register the home device's listen addresses so the away kernel can find it.
# The peer ID is the first path component of the OCAP URL (ocap:<peerId>/...).
yarn ocap daemon exec registerLocationHints '{"peerId": "HOME_PEER_ID", "hints": ["/ip4/.../udp/.../quic-v1/p2p/..."]}'
```

### 3d. Launch the wallet subcluster

The away role uses `away-coordinator.bundle` and pairs it with a `redeemer` vat (not `delegator`); the home role is the one that signs delegations, so the away kernel only needs the redeeming half. Set `allowedHosts` to the chain's RPC endpoints this VPS is permitted to reach.

```bash
yarn ocap daemon exec launchSubcluster '{
  "config": {
    "bootstrap": "coordinator",
    "forceReset": true,
    "services": ["ocapURLIssuerService", "ocapURLRedemptionService"],
    "vats": {
      "coordinator": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/away-coordinator.bundle",
        "globals": ["Date", "setTimeout"]
      },
      "keyring": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/keyring-vat.bundle",
        "globals": ["crypto"]
      },
      "provider": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/provider-vat.bundle",
        "globals": ["fetch", "Request", "Headers", "Response"],
        "network": { "allowedHosts": ["<chain>.infura.io", "api.pimlico.io", "swap.api.cx.metamask.io"] }
      },
      "redeemer": {
        "bundleSpec": "packages/evm-wallet-experiment/src/vats/redeemer-vat.bundle",
        "globals": []
      }
    }
  }
}'
```

### 3e. Initialize with a throwaway key

The away wallet gets a throwaway key (for signing UserOps within delegations):

```bash
yarn ocap daemon queueMessage ko4 initializeKeyring '[{"type":"throwaway"}]'
```

### 3f. Connect to the home wallet

```bash
yarn ocap daemon queueMessage ko4 connectToPeer '["ocap:zgAu...YOUR_OCAP_URL_HERE"]'
```

### 3g. Verify the connection

```bash
yarn ocap daemon queueMessage ko4 getCapabilities
```

Should show `hasPeerWallet: true`.

## 4. Delegate authority from home to away

If you used the automated scripts, this is handled automatically — the setup flow sends the away device's delegate address to the home device over QUIC/CapTP, the home device creates the delegation, and pushes it back. No copy-paste needed. See [Step 3 in Quick start](#step-3--delegate-authority-automatic).

When `--pimlico-key` is provided, both scripts set up smart accounts. The home script uses EIP-7702 to promote the EOA into a smart account (no separate contract or funding needed). The away script creates a Hybrid smart account (counterfactual — deploys on first UserOp). Delegations require smart accounts as delegator and delegate — this is handled automatically.

For manual setup, the steps are:

1. Create smart accounts on both devices:

```bash
# Home device (EIP-7702 — EOA becomes the smart account):
yarn ocap daemon queueMessage ko4 createSmartAccount '[{"chainId": 11155111, "implementation": "stateless7702"}]'

# Away device (Hybrid — deploys on first UserOp):
yarn ocap daemon queueMessage ko4 createSmartAccount '[{"chainId": 11155111}]'
```

The home EOA's existing ETH balance is used directly for delegated transfers — no separate funding step needed.

2. Read the delegate address from the away device (sent automatically by the setup flow after peer connection):

```bash
yarn ocap daemon queueMessage ko4 getDelegateAddress
```

3. Create the delegation on the home device (delegate = away smart account). See [Spending limits](#spending-limits) for adding caveats:

```bash
yarn ocap daemon queueMessage ko4 createDelegation '[{"delegate": "0xAWAY_SMART_ACCOUNT", "caveats": [], "chainId": 11155111}]'
```

4. Push the delegation to the away device (if connected):

```bash
yarn ocap daemon queueMessage ko4 pushDelegationToAway '[<DELEGATION_JSON>]'
```

Or transfer manually if the away device is offline:

```bash
# On the away device:
yarn ocap daemon queueMessage ko4 receiveDelegation '[<DELEGATION_JSON>]'
```

5. Verify:

```bash
yarn ocap daemon queueMessage ko4 getCapabilities
# Should show delegationCount: 1
```

## 5. Try it out

The wallet can be used via the agent (OpenClaw plugin) or directly through `yarn ocap daemon exec`. All commands below route through the kernel's capability system — the caller never touches private keys.

### Via the agent (OpenClaw)

Ask the agent natural-language questions and it will invoke the corresponding wallet tools:

- "What are my wallet accounts?"
- "What's the balance of 0x71fA...?"
- "How much USDC do I have?"
- "Send 0.001 ETH to 0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
- "Send 10 USDC to 0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
- "What's the contract address for LINK?"
- "Get a quote for swapping 0.1 ETH to USDC"
- "Swap 50 USDC for DAI"
- "Sign the message 'hello world'"
- "What capabilities does my wallet have?"

### Via the CLI

You can also call the wallet coordinator directly. Replace `ko4` with your `rootKref`.

```bash
# List accounts
yarn ocap daemon queueMessage ko4 getAccounts

# Check capabilities (local keys, peer wallet, delegations, bundler)
yarn ocap daemon queueMessage ko4 getCapabilities

# Sign a message
yarn ocap daemon queueMessage ko4 signMessage '["hello world"]'

# Sign a transaction
yarn ocap daemon queueMessage ko4 signTransaction '[{"to": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "value": "0x2386F26FC10000", "chainId": 11155111}]'

# Query the chain (eth_getBalance, eth_blockNumber, etc.)
yarn ocap daemon queueMessage ko4 request '["eth_getBalance", ["0x71fA1599e6c6FE46CD2A798E136f3ba22863cF82", "latest"]]'
yarn ocap daemon queueMessage ko4 request '["eth_blockNumber", []]'

# Create a delegation for another address
yarn ocap daemon queueMessage ko4 createDelegation '[{"delegate": "0x...", "caveats": [], "chainId": 11155111}]'

# List active delegations
yarn ocap daemon queueMessage ko4 listDelegations
```

## 6. How it works

```
Agent (AI)
  │
  ├─ wallet_balance  ──→  OpenClaw Plugin
  ├─ wallet_send     ──→       │
  └─ wallet_sign     ──→       │
                                │
                         yarn ocap daemon queueMessage
                                │
                          OCAP Daemon (Unix socket)
                                │
                          Kernel ─→ Coordinator Vat
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                 │
              Keyring Vat     Provider Vat     Delegation Vat
              (keys stay      (JSON-RPC)       (Gator framework)
               here)
                    │
              ┌─────┴─────┐
              │            │
         Local key    Peer wallet
         signing      (CapTP to home)
```

## 7. Verify everything works

Run the automated tests to confirm the setup:

```bash
# Unit tests (mocked) — should all pass
yarn workspace @ocap/evm-wallet-experiment test:dev:quiet

# Single-kernel integration (real SES + kernel)
yarn workspace @ocap/evm-wallet-experiment test:node

# Two-kernel peer wallet over QUIC
yarn workspace @ocap/evm-wallet-experiment test:node:peer

# Daemon integration (JSON-RPC socket)
yarn workspace @ocap/evm-wallet-experiment test:node:daemon

# Sepolia E2E (requires API keys)
PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
  yarn workspace @ocap/evm-wallet-experiment test:node:sepolia

# Full peer wallet E2E against Sepolia (two kernels + QUIC + UserOp)
PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
  MNEMONIC="your twelve word mnemonic" \
  yarn workspace @ocap/evm-wallet-experiment test:node:peer-e2e
```

> **Note:** The vitest-based integration tests (`test:integration`) may fail with SES lockdown errors (`TextEncoder is not a constructor` or `Date.now() throws`). This is a pre-existing kernel/SES environment issue, not an evm-wallet bug. The `test:node:*` scripts work around this by running as plain Node.js scripts.
