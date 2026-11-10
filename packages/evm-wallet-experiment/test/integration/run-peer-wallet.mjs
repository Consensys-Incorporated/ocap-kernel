/* oxlint-disable no-plusplus */
/**
 * Plain Node.js integration test for two-kernel peer wallet communication.
 *
 * Tests two kernels connected via QUIC, OCAP URL issuance/redemption,
 * remote signing forwarded via CapTP, and delegation transfer.
 *
 * Usage:
 *   yarn workspace @ocap/evm-wallet-experiment test:node:peer
 */

import '@metamask/kernel-shims/endoify-node';

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Kernel, kunser } from '@metamask/ocap-kernel';

import { makeWalletClusterConfig } from '../../src/cluster-config.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const EXPECTED_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const QUIC_LISTEN_ADDRESS = '/ip4/127.0.0.1/udp/0/quic-v1';
const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();

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

async function call(kernel, target, method, args = []) {
  const result = await kernel.queueMessage(target, method, args);
  await waitUntilQuiescent();
  return kunser(result);
}

async function callExpectError(kernel, target, method, args = []) {
  try {
    await kernel.queueMessage(target, method, args);
    await waitUntilQuiescent();
    return null;
  } catch (error) {
    await waitUntilQuiescent();
    return error;
  }
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
  console.log('\n=== Peer Wallet Integration Test (QUIC) ===\n');

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
  });
  const walletConfig2 = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    role: 'away',
  });

  let coord1, coord2;
  try {
    const r1 = await kernel1.launchSubcluster(walletConfig1);
    await waitUntilQuiescent();
    coord1 = r1.rootKref;

    const r2 = await kernel2.launchSubcluster(walletConfig2);
    await waitUntilQuiescent();
    coord2 = r2.rootKref;
    console.log(`  Wallet 1: ${coord1}, Wallet 2: ${coord2}\n`);
  } catch (error) {
    console.error('FATAL: Failed to launch wallet subclusters:', error.message);
    db1.close();
    db2.close();
    process.exit(1);
  }

  // -- Initialize home wallet --
  console.log('--- Initialize home wallet (kernel1) ---');
  await call(kernel1, coord1, 'initializeKeyring', [
    { type: 'srp', mnemonic: TEST_MNEMONIC },
  ]);
  const accounts1 = await call(kernel1, coord1, 'getAccounts');
  assert(accounts1.length === 1, 'home wallet has one account');
  assert(
    accounts1[0].toLowerCase() === EXPECTED_ADDRESS,
    `home address: ${accounts1[0]}`,
  );

  // -- Capabilities before peer connection --
  console.log('\n--- Capabilities before peer connection ---');
  const caps2Before = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2Before.hasLocalKeys === false, 'away wallet: no local keys');
  assert(caps2Before.hasPeerWallet === false, 'away wallet: no peer yet');

  // -- Establish peer connection via OCAP URL --
  console.log('\n--- Establish peer connection ---');
  const ocapUrl = await call(kernel1, coord1, 'issueOcapUrl');
  assert(typeof ocapUrl === 'string', 'OCAP URL is a string');
  assert(ocapUrl.startsWith('ocap:'), `OCAP URL: ${ocapUrl.slice(0, 40)}...`);

  await call(kernel2, coord2, 'connectToPeer', [ocapUrl]);
  const caps2After = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2After.hasPeerWallet === true, 'away wallet: peer connected');
  assert(caps2After.hasLocalKeys === false, 'away wallet: still no local keys');

  // -- Remote message signing --
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
  assert(
    msgSig === localSig,
    'remote signature matches home wallet local signature',
  );

  // -- Remote transaction signing (not supported — no peer fallback) --
  console.log(
    '\n--- Remote transaction signing (away → home, expect error) ---',
  );
  const tx = {
    from: accounts1[0],
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    value: '0xde0b6b3a7640000',
    chainId: 1,
    nonce: 0,
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
  };
  const txSignError = await callExpectError(
    kernel2,
    coord2,
    'signTransaction',
    [tx],
  );
  assert(
    txSignError instanceof Error,
    'remote tx signing rejected (no peer fallback)',
  );

  // -- Remote typed data signing (EIP-712) --
  console.log('\n--- Remote typed data signing (away → home) ---');
  const typedData = {
    domain: {
      name: 'Test',
      version: '1',
      chainId: 1,
      verifyingContract: '0x0000000000000000000000000000000000000001',
    },
    types: {
      Mail: [
        { name: 'from', type: 'string' },
        { name: 'to', type: 'string' },
        { name: 'contents', type: 'string' },
      ],
    },
    primaryType: 'Mail',
    message: { from: 'Alice', to: 'Bob', contents: 'Hello!' },
  };
  const remoteTypedSig = await call(kernel2, coord2, 'signTypedData', [
    typedData,
  ]);
  assert(remoteTypedSig.startsWith('0x'), 'remote typed data signed');
  assert(remoteTypedSig.length === 132, 'remote typed data sig is 65 bytes');
  const localTypedSig = await call(kernel1, coord1, 'signTypedData', [
    typedData,
  ]);
  assert(
    remoteTypedSig === localTypedSig,
    'remote typed data signature matches home wallet',
  );

  // -- Delegation grant transfer --
  console.log('\n--- Delegation grant transfer (home → away) ---');
  const grant = await call(kernel1, coord1, 'buildTransferNativeGrant', [
    {
      delegate: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      chainId: 1,
    },
  ]);
  assert(grant.delegation.status === 'signed', 'home delegation is signed');
  assert(typeof grant.delegation.id === 'string', 'delegation has id');

  await call(kernel2, coord2, 'receiveDelegation', [grant]);
  const awayGrants = await call(kernel2, coord2, 'listGrants');
  assert(awayGrants.length === 1, 'away wallet received one grant');
  assert(
    awayGrants[0].delegation.id === grant.delegation.id,
    'away wallet has the correct grant',
  );
  assert(
    awayGrants[0].delegation.status === 'signed',
    'away delegation is still signed',
  );

  // -- Away wallet with throwaway key + peer --
  console.log('\n--- Away wallet with throwaway key + peer ---');
  await call(kernel2, coord2, 'initializeKeyring', [{ type: 'throwaway' }]);
  const caps2Full = await call(kernel2, coord2, 'getCapabilities');
  assert(caps2Full.hasLocalKeys === true, 'away wallet: now has local keys');
  assert(caps2Full.hasPeerWallet === true, 'away wallet: still has peer');
  assert(caps2Full.delegationCount === 1, 'away wallet: has delegation');
  assert(
    caps2Full.localAccounts.length === 1,
    'away wallet: one throwaway account',
  );
  assert(
    caps2Full.localAccounts[0].toLowerCase() !== EXPECTED_ADDRESS,
    'throwaway is different from home address',
  );

  // -- No authority without peer --
  console.log('\n--- No authority without peer ---');
  const r3 = await kernel1.launchSubcluster(
    makeWalletClusterConfig({ bundleBaseUrl: BUNDLE_BASE_URL }),
  );
  await waitUntilQuiescent();
  const coord3 = r3.rootKref;
  const signError = await callExpectError(kernel1, coord3, 'signMessage', [
    'should fail',
  ]);
  assert(
    signError instanceof Error && signError.message.includes('No authority'),
    'error when no authority and no peer',
  );

  // -- Cleanup --
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
