/* oxlint-disable jsdoc/require-param-description, jsdoc/require-param-type, jsdoc/require-returns, node/no-sync, no-plusplus, no-empty-function, no-negated-condition, no-unused-vars, id-denylist, require-unicode-regexp */
/**
 * Interactive home wallet — MetaMask Mobile signs everything.
 *
 * Runs the kernel in-process (no daemon), connects MetaMask via SDK (QR code),
 * and registers the signer as a kernel service so the coordinator vat can call
 * it via E(externalSigner).signTypedData(...) etc.
 *
 * No mnemonic is stored on the home device.
 *
 * IMPORTANT: MetaMask SDK must connect BEFORE SES lockdown. SES freezes
 * built-in prototypes (TLS sockets, streams) which breaks the SDK's networking.
 * This script uses dynamic imports to control the order:
 *   1. Connect MetaMask (no SES)
 *   2. Activate SES lockdown
 *   3. Start kernel and proceed
 *
 * Usage:
 *   node packages/evm-wallet-experiment/scripts/home-interactive.mjs \
 *     --infura-key KEY [--pimlico-key KEY] [--chain sepolia] \
 *     [--relay MULTIADDR] [--quic-port 4002]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[0;32m';
const CYAN = '\x1b[0;36m';
const YELLOW = '\x1b[0;33m';
const RED = '\x1b[0;31m';
const RESET = '\x1b[0m';

// Keep references to the real console methods so our helpers always work,
// even after we mute console globally to suppress libp2p/comms noise.
const _log = console.log.bind(console);
const _error = console.error.bind(console);

/**
 *
 * @param msg
 */
const info = (msg) => _error(`${CYAN}->${RESET} ${msg}`);
/**
 *
 * @param msg
 */
const ok = (msg) => _error(`  ${GREEN}ok${RESET} ${msg}`);
/**
 *
 * @param msg
 */
const fail = (msg) => {
  _error(`  ${RED}error${RESET} ${msg}`);
  process.exit(1);
};

/** Suppress all console output from third-party code (libp2p, comms, etc.). */
function muteConsole() {
  /**
   *
   */
  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const CHAIN_NAME_TO_ID = {
  ethereum: 1,
  eth: 1,
  mainnet: 1,
  optimism: 10,
  op: 10,
  bsc: 56,
  bnb: 56,
  polygon: 137,
  matic: 137,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  linea: 59144,
  sepolia: 11155111,
};

const PIMLICO_SLUGS = {
  1: 'ethereum',
  10: 'optimism',
  56: 'binance',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  59144: 'linea',
  11155111: 'sepolia',
};

const INFURA_SUBDOMAINS = {
  1: 'mainnet',
  10: 'optimism-mainnet',
  137: 'polygon-mainnet',
  8453: 'base-mainnet',
  42161: 'arbitrum-mainnet',
  59144: 'linea-mainnet',
  11155111: 'sepolia',
};

/**
 * Resolve a chain name or numeric ID to a chain ID number.
 *
 * @param {string} value - Chain name (e.g. "base") or numeric ID string.
 * @returns {number} The resolved chain ID.
 */
function resolveChain(value) {
  const lower = value.toLowerCase();
  if (CHAIN_NAME_TO_ID[lower] !== undefined) {
    return CHAIN_NAME_TO_ID[lower];
  }
  const num = Number(value);
  if (!Number.isNaN(num) && num > 0) {
    return num;
  }
  // fail() calls process.exit — this return is unreachable but satisfies lint.
  fail(
    `Unknown chain "${value}". Supported: ${Object.keys(CHAIN_NAME_TO_ID).join(', ')}`,
  );
  return 0;
}

/**
 *
 * @param argv
 */
function parseArgs(argv) {
  const args = {
    infuraKey: '',
    pimlicoKey: '',
    chainId: 11155111,
    relay: '',
    quicPort: 4002,
    reset: false,
    rpcUrl: '',
    dbPath: join(
      process.env.OCAP_HOME || join(homedir(), '.ocap'),
      'kernel-interactive.sqlite',
    ),
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--infura-key':
        args.infuraKey = argv[++i];
        break;
      case '--pimlico-key':
        args.pimlicoKey = argv[++i];
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--chain':
        args.chainId = resolveChain(argv[++i]);
        break;
      case '--chain-id':
        args.chainId = resolveChain(argv[++i]);
        break;
      case '--relay':
        args.relay = argv[++i];
        break;
      case '--quic-port':
        args.quicPort = Number(argv[++i]);
        break;
      case '--rpc-url':
        args.rpcUrl = argv[++i];
        break;
      case '--db-path':
        args.dbPath = argv[++i];
        break;
      case '-h':
      case '--help':
        console.error(
          [
            `Usage: node home-interactive.mjs --infura-key KEY [options]`,
            ``,
            `Required (one of):`,
            `  --infura-key KEY    Infura API key (derives RPC URL from chain)`,
            `  --rpc-url URL       Custom RPC URL (overrides Infura derivation)`,
            ``,
            `Optional:`,
            `  --pimlico-key KEY   Pimlico API key (bundler/paymaster)`,
            `  --chain NAME        Chain name (e.g. sepolia, base, ethereum)`,
            `  --chain-id ID       Chain ID (alternative to --chain; default: 11155111)`,
            `  --relay MULTIADDR   Relay multiaddr`,
            `  --quic-port PORT    UDP port for QUIC (default: 4002)`,
            `  --db-path PATH      SQLite database path`,
            `  --reset             Purge all kernel state and start fresh`,
            ``,
            `Supported chains: ${Object.keys(CHAIN_NAME_TO_ID).join(', ')}`,
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        fail(`Unknown option: ${argv[i]}`);
    }
  }

  if (!args.infuraKey && !args.rpcUrl) {
    fail('--infura-key or --rpc-url is required');
  }

  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a line of input.
 *
 * @param question
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(`${CYAN}->${RESET} ${question}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Encode an ETH amount string to a 32-byte hex terms value.
 *
 * @param ethAmount
 */
function encodeEthToTerms(ethAmount) {
  const [whole, frac = ''] = ethAmount.split('.');
  if (frac.length > 18) {
    fail(`Amount "${ethAmount}" has too many decimal places (max 18 for ETH).`);
  }
  const fracPadded = frac.padEnd(18, '0');
  const wei = BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded);
  return `0x${wei.toString(16).padStart(64, '0')}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 *
 */
async function main() {
  const args = parseArgs(process.argv);

  const BUNDLE_BASE_URL = new URL('../src/vats', import.meta.url).toString();
  let RPC_URL;
  let RPC_HOST;
  if (args.rpcUrl) {
    RPC_URL = args.rpcUrl;
    const hostMatch = RPC_URL.match(/^https?:\/\/([^/:]+)/);
    RPC_HOST = hostMatch ? hostMatch[1] : 'localhost';
  } else {
    const infuraSub = INFURA_SUBDOMAINS[args.chainId];
    if (!infuraSub) {
      fail(
        `Infura does not support chain ${args.chainId}. Use --rpc-url instead. ` +
          `Infura-supported chains: ${Object.keys(INFURA_SUBDOMAINS).join(', ')}`,
      );
    }
    RPC_URL = `https://${infuraSub}.infura.io/v3/${args.infuraKey}`;
    RPC_HOST = `${infuraSub}.infura.io`;
  }
  const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';

  // -----------------------------------------------------------------------
  // 1. Connect MetaMask BEFORE SES lockdown.
  //    SES freezes built-in prototypes (TLS sockets, streams) which breaks
  //    the MetaMask SDK's networking. We connect first, then lock down.
  // -----------------------------------------------------------------------

  info('Connecting to MetaMask Mobile (scan the QR code)...');
  const { connectMetaMaskSigner } =
    await import('../src/lib/metamask-signer.ts');
  const signer = await connectMetaMaskSigner({
    dappMetadata: { name: 'OCAP Wallet', url: 'https://ocap.metamask.io' },
    infuraAPIKey: args.infuraKey,
  });

  const accounts = await signer.getAccounts();
  if (accounts.length === 0) {
    fail('No accounts returned from MetaMask');
  }
  ok(`MetaMask connected — account: ${accounts[0]}`);

  // Switch MetaMask to the target chain (e.g. Sepolia) so that
  // eth_signTypedData_v4 doesn't reject due to chain ID mismatch.
  const chainHex = `0x${args.chainId.toString(16)}`;
  try {
    await signer.provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainHex }],
    });
    ok(`Switched MetaMask to chain ${args.chainId}`);
  } catch (switchErr) {
    // 4902 = chain not added — not fatal, user may need to add it manually
    if (switchErr?.code !== 4902) {
      fail(
        `Failed to switch MetaMask to chain ${args.chainId}: ${switchErr.message}`,
      );
    }
    info(`Chain ${args.chainId} not found in MetaMask — add it manually`);
  }

  // -----------------------------------------------------------------------
  // 2. Activate SES lockdown, then import kernel modules
  // -----------------------------------------------------------------------

  info('Activating SES lockdown...');
  await import('@metamask/kernel-shims/endoify-node');
  ok('SES lockdown active');

  const { makeSQLKernelDatabase } =
    await import('@metamask/kernel-store/sqlite/nodejs');
  const { waitUntilQuiescent } = await import('@metamask/kernel-utils');
  const { Kernel, kunser, kslot } = await import('@metamask/ocap-kernel');
  const { Logger } = await import('@metamask/logger');
  const { NodejsPlatformServices } =
    await import('@metamask/kernel-node-runtime');
  const { makeWalletClusterConfig } = await import('../src/cluster-config.ts');

  // -----------------------------------------------------------------------
  // 3. Create kernel in-process with SQLite persistence
  // -----------------------------------------------------------------------

  info('Starting kernel...');
  const dbDir = join(args.dbPath, '..');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  const kernelDb = await makeSQLKernelDatabase({ dbFilename: args.dbPath });
  const platformServices = new NodejsPlatformServices({});
  // Only log warnings and errors — suppress verbose kernel debug output.
  const logger = new Logger({
    tags: ['ocap-kernel'],
    transports: [
      (entry) => {
        if (entry.level === 'error') {
          _error(
            `[${entry.tags.join(',')}] ${entry.message}`,
            ...(entry.data ?? []),
          );
        }
      },
    ],
  });
  const kernel = await Kernel.make(platformServices, kernelDb, {
    logger,
    ...(args.reset ? { resetStorage: true } : {}),
  });
  ok('Kernel started');

  // -----------------------------------------------------------------------
  // 4. Initialize remote comms (libp2p)
  // -----------------------------------------------------------------------

  const commsOptions = {
    directListenAddresses: [`/ip4/0.0.0.0/udp/${args.quicPort}/quic-v1`],
  };
  if (args.relay) {
    commsOptions.relays = [args.relay];
    // Extract the relay host for ws:// allowlist
    const hostMatch = args.relay.match(/\/(?:ip4|ip6|dns4|dns6)\/([^/]+)/);
    if (hostMatch) {
      commsOptions.allowedWsHosts = [hostMatch[1]];
    }
  }

  info('Initializing remote comms...');
  await kernel.initRemoteComms(commsOptions);

  // Wait for remote comms to be ready
  for (let i = 0; i < 30; i++) {
    const status = await kernel.getStatus();
    if (status.remoteComms?.state === 'connected') {
      break;
    }
    if (i === 29) {
      fail(
        `Remote comms did not reach 'connected' state after 30s (current: ${status.remoteComms?.state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  ok('Remote comms connected');

  // Mute all console output from libp2p/comms — only our helpers print from here.
  muteConsole();

  // -----------------------------------------------------------------------
  // 5. Launch wallet subcluster
  // -----------------------------------------------------------------------

  info('Launching wallet subcluster...');
  const walletConfig = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    delegationManagerAddress: DELEGATION_MANAGER,
    allowedHosts: [RPC_HOST, 'api.pimlico.io', 'swap.api.cx.metamask.io'],
  });

  const { rootKref } = await kernel.launchSubcluster(walletConfig);
  await waitUntilQuiescent();
  ok(`Subcluster launched — coordinator: ${rootKref}`);

  /**
   * Send a message to the coordinator and return the deserialized result.
   *
   * @param method
   * @param callArgs
   */
  async function call(method, callArgs = []) {
    const result = await kernel.queueMessage(rootKref, method, callArgs);
    await waitUntilQuiescent();
    return kunser(result);
  }

  /**
   * Like call(), but also returns the raw CapData for pasting into other scripts.
   *
   * @param method
   * @param callArgs
   */
  async function rawCall(method, callArgs = []) {
    const raw = await kernel.queueMessage(rootKref, method, callArgs);
    await waitUntilQuiescent();
    return { raw, value: kunser(raw) };
  }

  // -----------------------------------------------------------------------
  // 6. Register MetaMask signer as kernel service → pass to coordinator
  // -----------------------------------------------------------------------

  info('Registering MetaMask signer as kernel service...');
  const { kref: signerKref } = kernel.registerKernelServiceObject(
    'metamaskSigner',
    signer,
  );

  await call('connectExternalSigner', [kslot(signerKref, 'metamaskSigner')]);
  ok('External signer connected to coordinator');

  // -----------------------------------------------------------------------
  // 7. Configure provider
  // -----------------------------------------------------------------------

  info(`Configuring provider (chain ${args.chainId})...`);
  await call('configureProvider', [{ chainId: args.chainId, rpcUrl: RPC_URL }]);
  ok(`Provider configured — ${RPC_URL}`);

  // -----------------------------------------------------------------------
  // 8. Configure bundler (if Pimlico key provided)
  // -----------------------------------------------------------------------

  let smartAccountAddress;

  if (args.pimlicoKey) {
    const pimlicoSlug = PIMLICO_SLUGS[args.chainId];
    if (!pimlicoSlug) {
      fail(
        `Pimlico does not support chain ${args.chainId}. Supported: ${Object.keys(PIMLICO_SLUGS).join(', ')}`,
      );
    }
    const bundlerUrl = `https://api.pimlico.io/v2/${pimlicoSlug}/rpc?apikey=${args.pimlicoKey}`;
    info('Configuring bundler (Pimlico)...');
    await call('configureBundler', [
      {
        bundlerUrl,
        chainId: args.chainId,
        usePaymaster: true,
      },
    ]);
    ok(`Bundler configured — Pimlico (chain ${args.chainId})`);

    // Hybrid smart account — uses EIP-712 typed data for UserOp signing,
    // fully compatible with external signers (MetaMask).
    info('Configuring smart account...');
    const saResult = await call('createSmartAccount', [
      {
        chainId: args.chainId,
        implementation: 'hybrid',
      },
    ]);
    smartAccountAddress = saResult?.address;
    ok(`Smart account: ${smartAccountAddress}`);
    _error(`  ${DIM}factory        :${RESET} ${saResult?.factory ?? '(none)'}`);
    _error(
      `  ${DIM}factoryData len:${RESET} ${saResult?.factoryData ? saResult.factoryData.length : 0} chars`,
    );

    // Deploy the hybrid smart account if it isn't on-chain yet.
    // The DelegationManager needs code at the delegator address to validate
    // delegation redemptions. Without deployment, submitDelegationUserOp reverts.
    if (smartAccountAddress && saResult?.factory && saResult?.factoryData) {
      const code = await signer.provider.request({
        method: 'eth_getCode',
        params: [smartAccountAddress, 'latest'],
      });
      _error(
        `  ${DIM}eth_getCode    :${RESET} ${code?.slice(0, 20)}... (${(code?.length - 2) / 2} bytes)`,
      );
      if (code === '0x' || code === '0x0') {
        info('Deploying smart account on-chain via factory...');
        info('(MetaMask will show a transaction — please approve it)');
        try {
          const deployTxHash = await signer.provider.request({
            method: 'eth_sendTransaction',
            params: [
              {
                from: accounts[0],
                to: saResult.factory,
                data: saResult.factoryData,
              },
            ],
          });
          // Wait for the deployment transaction to be mined.
          // The DelegationManager needs code at the delegator address — if we
          // create the delegation before the tx confirms, isValidSignature()
          // returns empty data and delegation redemption reverts with NotSelf().
          info(`Waiting for deployment tx to confirm: ${deployTxHash}`);
          for (let i = 0; i < 90; i++) {
            const receipt = await signer.provider.request({
              method: 'eth_getTransactionReceipt',
              params: [deployTxHash],
            });
            if (receipt?.status === '0x1') {
              break;
            }
            if (receipt?.status === '0x0') {
              fail('Smart account deployment transaction reverted');
            }
            if (i === 89) {
              fail('Smart account deployment did not confirm after 3 minutes');
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          ok('Smart account deployed and confirmed on-chain');
        } catch (deployErr) {
          fail(`Could not deploy smart account: ${deployErr.message}`);
        }
      } else {
        ok('Smart account already deployed');
      }
    }

    // Fund the smart account if its balance is below 0.05 ETH.
    // The hybrid smart account has a different address from the EOA,
    // so it needs its own ETH to execute value transfers.
    if (smartAccountAddress) {
      const MIN_BALANCE_WEI = 50000000000000000n; // 0.05 ETH
      const TARGET_BALANCE_WEI = 100000000000000000n; // 0.1 ETH

      info('Checking smart account balance...');
      const balanceHex = await signer.provider.request({
        method: 'eth_getBalance',
        params: [smartAccountAddress, 'latest'],
      });
      const balanceWei = BigInt(balanceHex);

      if (balanceWei < MIN_BALANCE_WEI) {
        const fundWei = TARGET_BALANCE_WEI - balanceWei;
        const balanceEthStr = (Number(balanceWei) / 1e18).toFixed(4);
        info(
          `Smart account has ${balanceEthStr} ETH — funding to 0.1 ETH via MetaMask...`,
        );
        try {
          await signer.provider.request({
            method: 'eth_sendTransaction',
            params: [
              {
                from: accounts[0],
                to: smartAccountAddress,
                value: `0x${fundWei.toString(16)}`,
              },
            ],
          });
          ok(
            `Funded smart account with ${(Number(fundWei) / 1e18).toFixed(4)} ETH`,
          );
        } catch (fundErr) {
          info(`Could not fund smart account: ${fundErr.message}`);
          info(
            `You can fund it manually by sending ETH to ${smartAccountAddress}`,
          );
        }
      } else {
        ok(
          `Smart account balance: ${(Number(balanceWei) / 1e18).toFixed(4)} ETH`,
        );
      }
    }
  } else {
    info('Skipping bundler config (no --pimlico-key)');
  }

  // -----------------------------------------------------------------------
  // 9. Issue OCAP URL
  // -----------------------------------------------------------------------

  info('Issuing OCAP URL for the away device...');
  const ocapUrl = await call('issueOcapUrl', []);
  ok('OCAP URL issued');

  // -----------------------------------------------------------------------
  // 10. Extract listen addresses + detect public IP
  // -----------------------------------------------------------------------

  const status = await kernel.getStatus();
  const listenAddresses = [...(status.remoteComms?.listenAddresses ?? [])];

  // Detect public IP and prepend a public multiaddr so remote peers can connect.
  const peerId = listenAddresses
    .find((a) => a.includes('/p2p/'))
    ?.split('/p2p/')
    .pop();

  if (peerId) {
    try {
      const resp = await fetch('https://api.ipify.org', {
        signal: AbortSignal.timeout(5000),
      });
      const publicIp = (await resp.text()).trim();
      if (publicIp) {
        const publicAddr = `/ip4/${publicIp}/udp/${args.quicPort}/quic-v1/p2p/${peerId}`;
        listenAddresses.unshift(publicAddr);
        ok(`Public address: ${publicAddr}`);
      }
    } catch {
      // Public IP detection is best-effort
    }
  }

  // -----------------------------------------------------------------------
  // Output connection info
  // -----------------------------------------------------------------------

  _error(`
${GREEN}${BOLD}==============================================
  Home wallet setup complete! (Interactive mode)
==============================================${RESET}

  ${DIM}Coordinator kref :${RESET} ${rootKref}
  ${DIM}Chain ID         :${RESET} ${args.chainId}
  ${DIM}RPC URL          :${RESET} ${RPC_URL}
  ${DIM}Account          :${RESET} ${accounts[0]}${smartAccountAddress ? `\n  ${DIM}Smart Account    :${RESET} ${smartAccountAddress}` : ''}

${YELLOW}${BOLD}  Run this on the away device:${RESET}

${BOLD}  ./packages/evm-wallet-experiment/scripts/setup-away.sh \\
    --ocap-url "${ocapUrl}" \\
    --listen-addrs '${JSON.stringify(listenAddresses)}' \\
    --chain-id ${args.chainId}${args.rpcUrl ? ` \\\n    --rpc-url "${args.rpcUrl}"` : ''}${args.infuraKey ? ` \\\n    --infura-key ${args.infuraKey}` : ''}${args.pimlicoKey ? ` \\\n    --pimlico-key ${args.pimlicoKey}` : ''}${args.relay ? ` \\\n    --relay "${args.relay}"` : ''}${RESET}
`);

  // -----------------------------------------------------------------------
  // 11. Interactive delegation creation
  // -----------------------------------------------------------------------

  _error(
    `${YELLOW}${BOLD}  When setup-away.sh finishes, it will show a delegate address.\n  Paste that address below.${RESET}\n`,
  );

  const delegateAddr = await prompt(
    'Paste the delegate address from the away device: ',
  );

  if (!delegateAddr) {
    _error(
      `\n  ${DIM}No delegate address provided. You can create the delegation manually later.${RESET}\n`,
    );
  } else if (!/^0x[0-9a-fA-F]{40}$/u.test(delegateAddr)) {
    fail(`Invalid Ethereum address: ${delegateAddr}`);
  } else {
    // Prompt for spending limits
    _error('');
    _error(
      `  ${DIM}Spending limits restrict how much ETH the agent can spend.${RESET}`,
    );
    _error(
      `  ${DIM}Both are enforced on-chain — the agent cannot bypass them.${RESET}`,
    );
    _error('');

    const totalLimit = await prompt(
      'Total ETH spending limit (e.g. 0.1, or Enter for unlimited): ',
    );
    const txLimit = await prompt(
      'Max ETH per transaction (e.g. 0.01, or Enter for unlimited): ',
    );

    const caveats = [];
    if (totalLimit) {
      caveats.push({
        type: 'nativeTokenTransferAmount',
        enforcer: '0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320',
        terms: encodeEthToTerms(totalLimit),
      });
    }
    if (txLimit) {
      caveats.push({
        type: 'valueLte',
        enforcer: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F',
        terms: encodeEthToTerms(txLimit),
      });
    }

    // Final check: confirm smart account is deployed before creating delegation.
    // The DelegationManager calls isValidSignature() on the delegator during
    // redemption — if not deployed, it reverts with NotSelf().
    if (smartAccountAddress) {
      const codeCheck = await signer.provider.request({
        method: 'eth_getCode',
        params: [smartAccountAddress, 'latest'],
      });
      if (codeCheck === '0x' || codeCheck === '0x0') {
        fail(
          `Smart account ${smartAccountAddress} is not deployed on-chain. ` +
            `Delegation redemption will fail. Re-run with --reset to force redeployment.`,
        );
      }
      ok(
        `Delegator smart account confirmed deployed (${(codeCheck.length - 2) / 2} bytes)`,
      );

      // Verify the on-chain owner matches the MetaMask EOA.
      // The HybridDeleGator's isValidSignature checks ECDSA.recover == owner().
      try {
        const ownerResult = await signer.provider.request({
          method: 'eth_call',
          params: [
            {
              to: smartAccountAddress,
              // owner() selector = 0x8da5cb5b
              data: '0x8da5cb5b',
            },
            'latest',
          ],
        });
        if (ownerResult && ownerResult !== '0x') {
          const onChainOwner = `0x${ownerResult.slice(26).toLowerCase()}`;
          const expectedOwner = accounts[0].toLowerCase();
          if (onChainOwner === expectedOwner) {
            ok(`Smart account owner verified: ${onChainOwner}`);
          } else {
            _error(`  ${RED}WARNING: Smart account owner mismatch!${RESET}`);
            _error(`  ${RED}On-chain owner : ${onChainOwner}${RESET}`);
            _error(`  ${RED}Expected (EOA) : ${expectedOwner}${RESET}`);
            _error(
              `  ${RED}Delegation signing will fail. Re-run with --reset.${RESET}`,
            );
          }
        }
      } catch {
        // owner() call failed — not critical, continue
      }
    }

    // Verify MetaMask signing works correctly (EIP-712 domain is preserved).
    // MetaMask Mobile requires EIP712Domain in the types field — the signer
    // adapter injects it automatically. This test catches regressions.
    info('Verifying MetaMask EIP-712 signing...');
    try {
      const { hashTypedData, recoverAddress } = await import('viem');
      const testTypedData = {
        domain: {
          name: 'DelegationManager',
          version: '1',
          chainId: args.chainId,
          verifyingContract: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
        },
        types: {
          Delegation: [
            { name: 'delegate', type: 'address' },
            { name: 'delegator', type: 'address' },
            { name: 'authority', type: 'bytes32' },
            { name: 'caveats', type: 'Caveat[]' },
            { name: 'salt', type: 'uint256' },
          ],
          Caveat: [
            { name: 'enforcer', type: 'address' },
            { name: 'terms', type: 'bytes' },
          ],
        },
        primaryType: 'Delegation',
        message: {
          delegate: delegateAddr,
          delegator: smartAccountAddress ?? accounts[0],
          authority:
            '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          caveats: [],
          salt: BigInt(1),
        },
      };
      const testSig = await signer.signTypedData(testTypedData, accounts[0]);
      const testHash = hashTypedData(testTypedData);
      const testRecovered = await recoverAddress({
        hash: testHash,
        signature: testSig,
      });
      const directMatch =
        testRecovered.toLowerCase() === accounts[0].toLowerCase();
      if (directMatch) {
        ok('MetaMask EIP-712 signing verified');
      } else {
        _error(
          `  ${RED}MetaMask EIP-712 signing FAILED — signature mismatch${RESET}`,
        );
        _error(`  ${DIM}Expected : ${accounts[0]}${RESET}`);
        _error(`  ${DIM}Recovered: ${testRecovered}${RESET}`);

        // Check if the domain was lost (empty domain separator)
        const emptyDomainHash = hashTypedData({
          ...testTypedData,
          domain: {},
        });
        const emptyRecovered = await recoverAddress({
          hash: emptyDomainHash,
          signature: testSig,
        });
        if (emptyRecovered.toLowerCase() === accounts[0].toLowerCase()) {
          _error(
            `  ${RED}MetaMask signed with empty EIP-712 domain — EIP712Domain types injection may not be working${RESET}`,
          );
        }
      }
    } catch (testErr) {
      _error(
        `  ${DIM}MetaMask signing verification skipped: ${testErr.message}${RESET}`,
      );
    }

    if (caveats.length === 0) {
      info(`Creating delegation for ${delegateAddr} (no spending limits)...`);
    } else {
      info(`Creating delegation for ${delegateAddr} with spending limits...`);
    }

    const { raw: delegationRaw, value: delegation } = await rawCall(
      'createDelegation',
      [
        {
          delegate: delegateAddr,
          caveats,
          chainId: args.chainId,
        },
      ],
    );
    ok('Delegation created');

    // Verify the delegation signature off-chain before proceeding.
    // This catches EIP-712 hash mismatches (e.g. from BigInt serialization
    // issues) early, rather than failing later during on-chain redemption.
    if (delegation.signature && smartAccountAddress) {
      try {
        const { hashTypedData, recoverAddress } = await import('viem');

        // Compute the full EIP-712 typed data hash (domain + struct hash)
        const typedDataHash = hashTypedData({
          domain: {
            name: 'DelegationManager',
            version: '1',
            chainId: args.chainId,
            verifyingContract: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
          },
          types: {
            Delegation: [
              { name: 'delegate', type: 'address' },
              { name: 'delegator', type: 'address' },
              { name: 'authority', type: 'bytes32' },
              { name: 'caveats', type: 'Caveat[]' },
              { name: 'salt', type: 'uint256' },
            ],
            Caveat: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
            ],
          },
          primaryType: 'Delegation',
          message: {
            delegate: delegation.delegate,
            delegator: delegation.delegator,
            authority: delegation.authority,
            caveats: delegation.caveats.map((caveat) => ({
              enforcer: caveat.enforcer,
              terms: caveat.terms,
            })),
            salt: BigInt(delegation.salt),
          },
        });

        // Recover the signer from the signature
        const recoveredSigner = await recoverAddress({
          hash: typedDataHash,
          signature: delegation.signature,
        });

        const expectedSigner = accounts[0];
        const signerMatch =
          recoveredSigner.toLowerCase() === expectedSigner.toLowerCase();

        _error(`  ${DIM}EIP-712 typed hash    :${RESET} ${typedDataHash}`);
        _error(`  ${DIM}Recovered signer      :${RESET} ${recoveredSigner}`);
        _error(`  ${DIM}Expected signer (EOA) :${RESET} ${expectedSigner}`);
        _error(
          `  ${DIM}Smart account (owner) :${RESET} ${smartAccountAddress}`,
        );

        if (signerMatch) {
          ok('Delegation signature verified (signer matches EOA)');
        } else {
          _error(`  ${RED}WARNING: Delegation signature mismatch!${RESET}`);
          _error(
            `  ${RED}Recovered ${recoveredSigner} but expected ${expectedSigner}${RESET}`,
          );
          _error(
            `  ${RED}On-chain redemption will fail with InvalidERC1271Signature.${RESET}`,
          );
          _error(
            `  ${RED}This likely indicates an EIP-712 hash mismatch between MetaMask and the contract.${RESET}`,
          );
        }
      } catch (verifyErr) {
        _error(
          `  ${DIM}Signature verification skipped: ${verifyErr.message}${RESET}`,
        );
      }
    }

    _error(`
${YELLOW}${BOLD}  Copy this delegation JSON and paste it into the away device
  script when prompted:${RESET}

${BOLD}${JSON.stringify(delegationRaw)}${RESET}

  ${DIM}ID        :${RESET} ${delegation.id}
  ${DIM}Status    :${RESET} ${delegation.status}
  ${DIM}Delegator :${RESET} ${delegation.delegator}
  ${DIM}Delegate  :${RESET} ${delegation.delegate}
`);
  }

  // -----------------------------------------------------------------------
  // 12. Stay running — signing requests come in via CapTP
  // -----------------------------------------------------------------------

  _error(
    `${GREEN}${BOLD}  Listening for signing requests... (Ctrl+C to stop)${RESET}\n`,
  );

  // Keep the process alive
  const keepAlive = setInterval(() => {}, 60_000);

  process.on('SIGINT', async () => {
    _error(`\n${CYAN}->${RESET} Shutting down...`);
    clearInterval(keepAlive);
    signer.disconnect();
    try {
      await kernel.stop();
    } catch {
      // Ignore stop errors
    }
    kernelDb.close();
    _error(`  ${GREEN}ok${RESET} Goodbye`);
    process.exit(0);
  });
}

main().catch((error) => {
  _error(`${RED}FATAL:${RESET}`, error);
  process.exit(1);
});
