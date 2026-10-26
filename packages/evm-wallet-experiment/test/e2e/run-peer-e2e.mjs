/* oxlint-disable no-plusplus, node/no-process-env */
/**
 * Full E2E peer wallet test against Sepolia.
 *
 * Exercises the complete two-kernel delegation flow: two kernels connected
 * via QUIC, peer wallet signing forwarded via CapTP, provider queries,
 * delegation grant creation/transfer, smart account creation, and UserOp
 * redemption — all against the Sepolia testnet.
 *
 * ── Architecture ───────────────────────────────────────────────────────
 *
 *   kernel1 = home coordinator  (holds keys, manages delegations)
 *   kernel2 = away coordinator  (autonomous agent, receives delegation grants)
 *
 * ── What it tests ──────────────────────────────────────────────────────
 *
 *   1. Two in-process kernels connected over local QUIC (UDP)
 *   2. OCAP URL issuance (kernel1) and redemption (kernel2)
 *   3. Remote message + transaction signing forwarded via CapTP
 *   4. Provider RPC queries (eth_blockNumber, eth_getBalance) through kernel2
 *   5. Cross-kernel delegation grant creation (home) and transfer (away)
 *   6. Smart account creation on home (counterfactual Hybrid via Delegation Framework)
 *   7. Self-delegation redemption via ERC-4337 UserOp submitted to Pimlico (home)
 *   8. On-chain inclusion verified by polling the bundler for the receipt
 *
 * ── Environment variables (required) ───────────────────────────────────
 *
 *   PIMLICO_API_KEY  Pimlico API key — free tier works for Sepolia.
 *                    Get one at https://dashboard.pimlico.io
 *                    Also create a sponsorship policy at
 *                    https://dashboard.pimlico.io/sponsorship-policies
 *                    (the test uses `sp_young_killmonger` — replace if
 *                    using your own policy).
 *
 *   SEPOLIA_RPC_URL  Sepolia JSON-RPC endpoint, e.g. Infura or Alchemy.
 *                    For Infura: sign up at https://developer.metamask.io
 *                    and use https://sepolia.infura.io/v3/<YOUR_KEY>
 *
 *   MNEMONIC         BIP-39 mnemonic for a funded Sepolia wallet.
 *                    The first derived account (m/44'/60'/0'/0/0) must
 *                    hold a small amount of Sepolia ETH. The paymaster
 *                    sponsors UserOp gas, but the EOA itself is used for
 *                    signing delegations.
 *                    Free testnet ETH:
 *                      - https://docs.metamask.io/developer-tools/faucet
 *                      - https://sepolia-faucet.pk910.de/
 *
 * ── Network / firewall ─────────────────────────────────────────────────
 *
 *   This test runs both kernels in the same process on localhost, so no
 *   inbound ports need to be opened. QUIC binds to 127.0.0.1 on an
 *   ephemeral UDP port (`:0`).
 *
 *   If you run this on a VPS the only outbound access required is:
 *     - HTTPS (TCP 443) to Infura (sepolia.infura.io) for JSON-RPC
 *     - HTTPS (TCP 443) to Pimlico (api.pimlico.io) for bundler + paymaster
 *
 *   For the production two-device setup (home + VPS), see the
 *   "Ports and firewall" section in docs/setup-guide.md.
 *
 * ── Prerequisites ──────────────────────────────────────────────────────
 *
 *   - Node.js >= 22
 *   - The monorepo cloned and dependencies installed (`yarn install`)
 *   - Vat bundles built (`yarn workspace @ocap/evm-wallet-experiment build`)
 *     — the test:node:peer-e2e script runs `build` automatically
 *
 * ── Usage ──────────────────────────────────────────────────────────────
 *
 *   PIMLICO_API_KEY=xxx \
 *   SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
 *   MNEMONIC="word1 word2 ... word12" \
 *     yarn workspace @ocap/evm-wallet-experiment test:node:peer-e2e
 *
 *   The test takes ~30–90 s depending on Sepolia block times and Pimlico
 *   bundler latency. The UserOp polling timeout is 120 s.
 *
 *   Exit code 0 = all assertions passed; 1 = at least one failed.
 *   If PIMLICO_API_KEY, SEPOLIA_RPC_URL, or MNEMONIC is missing the
 *   test exits 0 (skip) with a diagnostic message.
 */

import '@metamask/kernel-shims/endoify-node';

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Kernel, kunser } from '@metamask/ocap-kernel';

import { makeWalletClusterConfig } from '../../src/cluster-config.ts';
import { getDelegationManagerAddress } from '../../src/lib/sdk.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { PIMLICO_API_KEY, SEPOLIA_RPC_URL, MNEMONIC } = process.env;

if (!PIMLICO_API_KEY || !SEPOLIA_RPC_URL || !MNEMONIC) {
  console.log(
    '\nSkipping Peer E2E: set PIMLICO_API_KEY, SEPOLIA_RPC_URL, and MNEMONIC\n',
  );
  process.exit(0);
}

const SEPOLIA_CHAIN_ID = 11155111;
const QUIC_LISTEN_ADDRESS = '/ip4/127.0.0.1/udp/0/quic-v1';
const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();
const DEPLOY_SALT = `0x${Date.now().toString(16).padStart(64, '0')}`;
const USEROP_TIMEOUT = 120_000;

const delegationManagerAddress = getDelegationManagerAddress(SEPOLIA_CHAIN_ID);
const bundlerUrl = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

async function call(
  kernel,
  target,
  method,
  args = [],
  timeout = USEROP_TIMEOUT,
) {
  const resultP = kernel.queueMessage(target, method, args);

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      resultP.then((capData) => ({ done: true, capData })),
      new Promise((resolve) => setTimeout(() => resolve({ done: false }), 500)),
    ]);

    if (winner.done) {
      await waitUntilQuiescent();
      return kunser(winner.capData);
    }

    await waitUntilQuiescent();
  }

  throw new Error(`call(${method}) timed out after ${timeout}ms`);
}

async function getConnectedInfo(kernel) {
  const status = await kernel.getStatus();
  if (status.remoteComms?.state !== 'connected') {
    throw new Error('Remote comms not connected');
  }
  const { peerId, listenAddresses } = status.remoteComms;
  return {
    peerId,
    listenAddresses,
    quicAddresses: listenAddresses.filter((addr) => addr.includes('/quic-v1/')),
  };
}

async function stopWithTimeout(stopFn, timeoutMs, label) {
  try {
    await Promise.race([
      stopFn(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs),
      ),
    ]);
  } catch {
    // Ignore timeout errors during cleanup
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Peer Wallet Sepolia E2E Test ===\n');

  // -- Setup: Two kernels with QUIC --
  console.log('Setting up two kernels with QUIC transport...');
  const db1 = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const db2 = await makeSQLKernelDatabase({ dbFilename: ':memory:' });

  const kernel1 = await Kernel.make(new NodejsPlatformServices({}), db1, {
    resetStorage: true,
  });
  const kernel2 = await Kernel.make(new NodejsPlatformServices({}), db2, {
    resetStorage: true,
  });

  await kernel1.initRemoteComms({
    directListenAddresses: [QUIC_LISTEN_ADDRESS],
  });
  await kernel2.initRemoteComms({
    directListenAddresses: [QUIC_LISTEN_ADDRESS],
  });

  const info1 = await getConnectedInfo(kernel1);
  const info2 = await getConnectedInfo(kernel2);
  await kernel1.registerLocationHints(info2.peerId, info2.quicAddresses);
  await kernel2.registerLocationHints(info1.peerId, info1.quicAddresses);

  console.log(`  Kernel 1 peer: ${info1.peerId.slice(0, 16)}...`);
  console.log(`  Kernel 2 peer: ${info2.peerId.slice(0, 16)}...`);

  // -- Launch wallet subclusters --
  console.log('Launching wallet subclusters...');
  const walletConfig1 = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    allowedHosts: ['sepolia.infura.io', 'api.pimlico.io'],
    delegationManagerAddress,
  });
  const walletConfig2 = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    role: 'away',
    allowedHosts: ['sepolia.infura.io', 'api.pimlico.io'],
    delegationManagerAddress,
  });

  let coord1, coord2;
  try {
    const r1 = await kernel1.launchSubcluster(walletConfig1);
    await waitUntilQuiescent();
    coord1 = r1.rootKref;

    const r2 = await kernel2.launchSubcluster(walletConfig2);
    await waitUntilQuiescent();
    coord2 = r2.rootKref;
    console.log(`  Wallet 1: ${coord1}, Wallet 2: ${coord2}`);
  } catch (error) {
    console.error('FATAL: Failed to launch wallet subclusters:', error.message);
    db1.close();
    db2.close();
    process.exit(1);
  }

  console.log(`  DelegationManager: ${delegationManagerAddress}\n`);

  // =====================================================================
  // 1. Initialize keyrings
  // =====================================================================

  console.log('--- Initialize home wallet (kernel1) ---');
  await call(kernel1, coord1, 'initializeKeyring', [
    { type: 'srp', mnemonic: MNEMONIC },
  ]);
  const homeAccounts = await call(kernel1, coord1, 'getAccounts');
  assert(homeAccounts.length > 0, `home EOA: ${homeAccounts[0]}`);
  const homeAddr = homeAccounts[0];

  // NOTE: We do NOT init kernel2's keyring yet — remote signing via peer
  // must be tested before the local keyring exists, because the coordinator
  // uses keyring → externalSigner → peerWallet priority.

  // =====================================================================
  // 2. Configure provider on both kernels (Sepolia RPC)
  // =====================================================================

  console.log('\n--- Configure Sepolia provider ---');
  await call(kernel1, coord1, 'configureProvider', [
    { chainId: SEPOLIA_CHAIN_ID, rpcUrl: SEPOLIA_RPC_URL },
  ]);
  assert(true, 'kernel1 provider configured');

  await call(kernel2, coord2, 'configureProvider', [
    { chainId: SEPOLIA_CHAIN_ID, rpcUrl: SEPOLIA_RPC_URL },
  ]);
  assert(true, 'kernel2 provider configured');

  // =====================================================================
  // 3. Configure bundler on both kernels (Pimlico)
  // =====================================================================

  console.log('\n--- Configure Pimlico bundler (both kernels) ---');
  await call(kernel1, coord1, 'configureBundler', [
    {
      bundlerUrl,
      chainId: SEPOLIA_CHAIN_ID,
      usePaymaster: true,
      sponsorshipPolicyId: 'sp_young_killmonger',
    },
  ]);
  assert(true, 'kernel1 bundler configured');

  await call(kernel2, coord2, 'configureBundler', [
    {
      bundlerUrl,
      chainId: SEPOLIA_CHAIN_ID,
      usePaymaster: true,
      sponsorshipPolicyId: 'sp_young_killmonger',
    },
  ]);
  assert(true, 'kernel2 bundler configured');

  // =====================================================================
  // 4. Establish peer connection via OCAP URL
  // =====================================================================

  console.log('\n--- Establish peer connection ---');
  const caps2Before = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2Before.hasPeerWallet === false, 'away: no peer yet');

  const ocapUrl = await call(kernel1, coord1, 'issueOcapUrl');
  assert(typeof ocapUrl === 'string', 'OCAP URL is a string');
  assert(ocapUrl.startsWith('ocap:'), `OCAP URL: ${ocapUrl.slice(0, 40)}...`);

  await call(kernel2, coord2, 'connectToPeer', [ocapUrl]);
  const caps2After = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2After.hasPeerWallet === true, 'away: peer connected');

  // =====================================================================
  // 5. Remote signing via peer (kernel2 → kernel1)
  // =====================================================================

  console.log('\n--- Remote message signing (away → home) ---');
  const msgSig = await call(kernel2, coord2, 'signMessage', [
    'Hello from the away wallet',
  ]);
  assert(typeof msgSig === 'string', 'remote signature is a string');
  assert(msgSig.startsWith('0x'), 'remote signature starts with 0x');
  assert(
    msgSig.length === 132,
    `remote signature is 65 bytes (got ${msgSig.length})`,
  );

  const localSig = await call(kernel1, coord1, 'signMessage', [
    'Hello from the away wallet',
  ]);
  assert(msgSig === localSig, 'remote signature matches home wallet');

  // Transaction signing has no peer fallback — the away kernel must use
  // delegation redemption for sends. Verify it rejects correctly.
  console.log(
    '\n--- Remote transaction signing (away → home, expect error) ---',
  );
  const tx = {
    from: homeAddr,
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    value: '0xde0b6b3a7640000',
    chainId: SEPOLIA_CHAIN_ID,
    nonce: 0,
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
  };
  let txSignError;
  try {
    await kernel2.queueMessage(coord2, 'signTransaction', [tx]);
  } catch (error) {
    txSignError = error;
  }
  await waitUntilQuiescent();
  assert(txSignError instanceof Error, 'remote tx signing returned error');
  assert(
    txSignError.message.includes('No authority to sign this transaction'),
    'remote tx signing rejected (no peer fallback)',
  );

  // =====================================================================
  // 6. Provider queries via kernel2
  // =====================================================================

  console.log('\n--- Provider queries (kernel2) ---');
  const blockNumber = await call(kernel2, coord2, 'request', [
    'eth_blockNumber',
    [],
  ]);
  assert(
    typeof blockNumber === 'string' && blockNumber.startsWith('0x'),
    `eth_blockNumber: ${blockNumber}`,
  );

  const balance = await call(kernel2, coord2, 'request', [
    'eth_getBalance',
    [homeAddr, 'latest'],
  ]);
  assert(
    typeof balance === 'string' && balance.startsWith('0x'),
    `eth_getBalance(home): ${balance}`,
  );

  // =====================================================================
  // 7. Initialize throwaway keyring on kernel2
  // =====================================================================

  console.log('\n--- Initialize throwaway keyring (kernel2) ---');
  await call(kernel2, coord2, 'initializeKeyring', [{ type: 'throwaway' }]);

  // getAccounts returns only peer (home) accounts — throwaway is hidden
  const awayAccounts = await call(kernel2, coord2, 'getAccounts');
  assert(awayAccounts.length === 1, 'away wallet shows one account');
  assert(
    awayAccounts[0].toLowerCase() === homeAddr.toLowerCase(),
    'away getAccounts returns home address',
  );

  const caps2Full = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2Full.hasLocalKeys === true, 'away: now has local keys');
  assert(caps2Full.hasPeerWallet === true, 'away: still has peer');

  // Throwaway is available via getCapabilities().localAccounts for delegation use
  assert(caps2Full.localAccounts.length === 1, 'away: one local account');
  const throwawayAddr = caps2Full.localAccounts[0];
  assert(
    throwawayAddr.toLowerCase() !== homeAddr.toLowerCase(),
    'throwaway is different from home address',
  );
  console.log(`  Throwaway: ${throwawayAddr}`);

  // =====================================================================
  // 8. Delegation grant transfer (home → away)
  //    Home creates a TransferNativeGrant for the throwaway delegate;
  //    away receives it and verifies routing is set up.
  // =====================================================================

  console.log('\n--- Build delegation grant (kernel1 → kernel2 throwaway) ---');
  const xferGrant = await call(kernel1, coord1, 'buildTransferNativeGrant', [
    {
      delegate: throwawayAddr,
      chainId: SEPOLIA_CHAIN_ID,
    },
  ]);
  assert(
    xferGrant.delegation.status === 'signed',
    'transfer delegation signed',
  );
  assert(
    xferGrant.delegation.delegator.toLowerCase() === homeAddr.toLowerCase(),
    'delegator is home EOA',
  );
  assert(
    xferGrant.delegation.delegate.toLowerCase() === throwawayAddr.toLowerCase(),
    'delegate is throwaway',
  );
  console.log(`  Delegation ID: ${xferGrant.delegation.id.slice(0, 20)}...`);

  console.log('\n--- Transfer grant to kernel2 ---');
  await call(kernel2, coord2, 'receiveDelegation', [xferGrant]);
  const awayGrants = await call(kernel2, coord2, 'listGrants');
  assert(awayGrants.length === 1, 'away received one grant');
  assert(
    awayGrants[0].delegation.id === xferGrant.delegation.id,
    'correct delegation id',
  );
  assert(
    awayGrants[0].delegation.status === 'signed',
    'delegation status: signed',
  );

  const caps2Deleg = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2Deleg.delegationCount === 1, 'away: delegationCount === 1');

  // =====================================================================
  // 9. Verify home grant list
  //    On-chain revocation is a home-side operation (revokeGrant). Verify
  //    the grant issued in section 8 appears in coord1's list.
  // =====================================================================

  console.log('\n--- Verify home grant list (kernel1) ---');
  const homeGrants = await call(kernel1, coord1, 'listGrants');
  assert(homeGrants.length === 1, 'home: one grant issued');
  assert(
    homeGrants[0].delegation.id === xferGrant.delegation.id,
    'home grant matches transferred delegation',
  );

  // =====================================================================
  // 10. Smart account + self-delegation + UserOp redemption (kernel1)
  //     On-chain redemption requires the delegator to be the calling
  //     DeleGator smart account, so we use a self-delegation here.
  //     Redemption is a home-side operation; the away coordinator routes
  //     transfers internally via the delegation twin.
  // =====================================================================

  console.log('\n--- Create smart account (kernel1) ---');
  const smartConfig = await call(kernel1, coord1, 'createSmartAccount', [
    { deploySalt: DEPLOY_SALT, chainId: SEPOLIA_CHAIN_ID },
  ]);
  assert(
    typeof smartConfig.address === 'string' &&
      smartConfig.address.match(/^0x[\da-f]{40}$/iu),
    `smart account: ${smartConfig.address}`,
  );
  assert(smartConfig.implementation === 'hybrid', 'implementation: hybrid');
  assert(smartConfig.deployed === false, 'not yet deployed');

  console.log('\n--- Build self-delegation grant (kernel1 smart account) ---');
  const selfGrant = await call(kernel1, coord1, 'buildTransferNativeGrant', [
    {
      delegate: smartConfig.address,
      chainId: SEPOLIA_CHAIN_ID,
    },
  ]);
  assert(selfGrant.delegation.status === 'signed', 'self-delegation signed');
  assert(
    selfGrant.delegation.delegator.toLowerCase() ===
      smartConfig.address.toLowerCase(),
    'delegator is smart account',
  );
  assert(
    selfGrant.delegation.delegate.toLowerCase() ===
      smartConfig.address.toLowerCase(),
    'delegate is smart account',
  );
  console.log(`  Delegation ID: ${selfGrant.delegation.id.slice(0, 20)}...`);

  console.log('\n--- Redeem self-delegation (submit UserOp) ---');
  console.log('  Submitting to Pimlico bundler...');
  const userOpHash = await call(kernel1, coord1, 'redeemDelegation', [
    {
      delegation: selfGrant.delegation,
      execution: {
        target: smartConfig.address,
        value: '0x0',
        callData: '0x',
      },
    },
  ]);
  assert(
    typeof userOpHash === 'string' && userOpHash.match(/^0x[\da-f]{64}$/iu),
    `userOp hash: ${userOpHash}`,
  );

  // -- Wait for on-chain inclusion --
  console.log('\n--- Wait for UserOp receipt ---');
  console.log(`  Polling (timeout: ${USEROP_TIMEOUT / 1000}s)...`);
  const deadline = Date.now() + USEROP_TIMEOUT;
  let receipt = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(bundlerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getUserOperationReceipt',
          params: [userOpHash],
        }),
      });
      const json = await resp.json();
      if (json.result) {
        receipt = json.result;
        break;
      }
    } catch {
      // ignore fetch errors during polling
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert(receipt !== null && receipt !== undefined, 'receipt received');
  assert(receipt.success === true, 'UserOp succeeded on-chain');
  if (receipt?.receipt?.transactionHash) {
    console.log(
      `  Tx: https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`,
    );
  }

  // -- Verify smart account persisted --
  console.log('\n--- Verify post-redemption state ---');
  const caps1Post = await call(kernel1, coord1, 'getCapabilities');
  assert(
    caps1Post.smartAccountAddress === smartConfig.address,
    'smart account address persisted',
  );

  // =====================================================================
  // Cleanup
  // =====================================================================

  console.log('\n--- Cleanup ---');
  await Promise.all([
    stopWithTimeout(() => kernel1.stop(), 3000, 'kernel1'),
    stopWithTimeout(() => kernel2.stop(), 3000, 'kernel2'),
  ]);
  db1.close();
  db2.close();
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
