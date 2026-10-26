/* oxlint-disable jsdoc/require-param-description, jsdoc/require-returns-description, no-plusplus */
/**
 * Integration test for the evm-wallet subcluster accessed via the daemon
 * JSON-RPC socket. Verifies the full stack: daemon → kernel → vats.
 *
 * This simulates how an agent process talks to the wallet: through the
 * daemon's Unix socket using JSON-RPC, not by calling kernel methods
 * directly.
 *
 * Usage:
 *   yarn workspace @ocap/evm-wallet-experiment test:node:daemon
 */

import '@metamask/kernel-shims/endoify-node';

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import {
  startRpcSocketServer,
  readLine,
  writeLine,
} from '@metamask/kernel-node-runtime/daemon';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Kernel, kunser } from '@metamask/ocap-kernel';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeWalletClusterConfig } from '../../src/cluster-config.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const EXPECTED_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let rpcId = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function tempSocketPath() {
  return join(
    tmpdir(),
    `evm-wallet-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

async function connectToSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.removeListener('error', reject);
      resolve(client);
    });
    client.on('error', reject);
  });
}

/**
 * Send a JSON-RPC request over the daemon socket.
 *
 * @param {string} socketPath
 * @param {string} method
 * @param {unknown} [params]
 * @returns {Promise<Record<string, unknown>>}
 */
async function rpc(socketPath, method, params) {
  const socket = await connectToSocket(socketPath);
  try {
    rpcId++;
    const request = {
      jsonrpc: '2.0',
      id: String(rpcId),
      method,
      ...(params === undefined ? {} : { params }),
    };
    await writeLine(socket, JSON.stringify(request));
    const responseLine = await readLine(socket);
    return JSON.parse(responseLine);
  } finally {
    socket.destroy();
  }
}

/**
 * Send a queueMessage RPC and deserialize the result.
 * The daemon's queueMessage takes [target, method, args] as a tuple.
 *
 * @param {string} socketPath
 * @param {string} target
 * @param {string} method
 * @param {unknown[]} [args]
 * @returns {Promise<unknown>}
 */
async function callVat(socketPath, target, method, args = []) {
  const response = await rpc(socketPath, 'queueMessage', [
    target,
    method,
    args,
  ]);
  if (response.error) {
    throw new Error(
      `RPC error: ${response.error.message || JSON.stringify(response.error)}`,
    );
  }
  // queueMessage returns CapData — deserialize it
  await waitUntilQuiescent();
  return kunser(response.result);
}

/**
 * Send a queueMessage RPC expecting it to fail, and return the error message.
 * Throws if the call unexpectedly succeeds.
 *
 * @param {string} socketPath
 * @param {string} target
 * @param {string} method
 * @param {unknown[]} [args]
 * @returns {Promise<string>}
 */
async function callVatExpectError(socketPath, target, method, args = []) {
  const response = await rpc(socketPath, 'queueMessage', [
    target,
    method,
    args,
  ]);
  if (response.error) {
    return response.error.message;
  }
  await waitUntilQuiescent();
  throw new Error(
    `Expected error but call succeeded: ${JSON.stringify(response.result)}`,
  );
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Daemon Wallet Integration Test ===\n');

  // -----------------------------------------------------------------------
  // Setup: kernel + RPC socket server (simulates daemon)
  // -----------------------------------------------------------------------

  console.log('Booting daemon stack...');
  const socketPath = tempSocketPath();
  const kernelDb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const platformServices = new NodejsPlatformServices({});
  const kernel = await Kernel.make(platformServices, kernelDb, {
    resetStorage: true,
  });
  await kernel.initIdentity();

  const rpcServer = await startRpcSocketServer({
    socketPath,
    kernel,
    kernelDatabase: kernelDb,
  });
  console.log(`  Socket: ${socketPath}`);

  // -----------------------------------------------------------------------
  // Test 1: Daemon getStatus works
  // -----------------------------------------------------------------------

  console.log('\n--- Daemon getStatus ---');
  const statusResp = await rpc(socketPath, 'getStatus');
  assert(statusResp.error === undefined, 'getStatus succeeds');
  assert(statusResp.result !== undefined, 'getStatus returns result');
  assert(Array.isArray(statusResp.result.vats), 'status contains vats array');

  // -----------------------------------------------------------------------
  // Test 2: Launch wallet subcluster via daemon RPC
  // -----------------------------------------------------------------------

  console.log('\n--- Launch wallet subcluster via RPC ---');
  const walletConfig = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
  });

  const launchResp = await rpc(socketPath, 'launchSubcluster', {
    config: walletConfig,
  });
  await waitUntilQuiescent();

  assert(launchResp.error === undefined, 'launchSubcluster succeeds');
  const { rootKref, subclusterId } = launchResp.result;
  assert(typeof rootKref === 'string', `coordinator kref: ${rootKref}`);
  assert(typeof subclusterId === 'string', `subcluster id: ${subclusterId}`);

  // -----------------------------------------------------------------------
  // Test 3: Initialize keyring via daemon → queueMessage
  // -----------------------------------------------------------------------

  console.log('\n--- Initialize keyring via daemon ---');
  await callVat(socketPath, rootKref, 'initializeKeyring', [
    { type: 'srp', mnemonic: TEST_MNEMONIC },
  ]);
  console.log('  Keyring initialized through daemon.');

  const accounts = await callVat(socketPath, rootKref, 'getAccounts');
  assert(accounts.length === 1, 'one account via daemon');
  assert(
    accounts[0].toLowerCase() === EXPECTED_ADDRESS,
    `correct address via daemon: ${accounts[0]}`,
  );

  // -----------------------------------------------------------------------
  // Test 4: Sign message via daemon
  // -----------------------------------------------------------------------

  console.log('\n--- Sign message via daemon ---');
  const msgSig = await callVat(socketPath, rootKref, 'signMessage', [
    'Hello via daemon!',
  ]);
  assert(
    typeof msgSig === 'string' && msgSig.startsWith('0x'),
    'signature via daemon',
  );
  assert(
    msgSig.length === 132,
    `65-byte signature (${msgSig.length} hex chars)`,
  );

  // -----------------------------------------------------------------------
  // Test 5: Sign transaction via daemon
  // -----------------------------------------------------------------------

  console.log('\n--- Sign transaction via daemon ---');
  const tx = {
    from: accounts[0],
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    value: '0xde0b6b3a7640000',
    chainId: 1,
    nonce: 0,
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
  };
  const signedTx = await callVat(socketPath, rootKref, 'signTransaction', [tx]);
  assert(signedTx.startsWith('0x'), 'signed tx via daemon');
  assert(signedTx.length > 100, `signed tx: ${signedTx.length} chars`);

  // -----------------------------------------------------------------------
  // Test 6: Build delegation grant via daemon
  // -----------------------------------------------------------------------

  console.log('\n--- Build delegation grant via daemon ---');
  const grant = await callVat(
    socketPath,
    rootKref,
    'buildTransferNativeGrant',
    [
      {
        delegate: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        chainId: 1,
      },
    ],
  );
  assert(grant.delegation.status === 'signed', 'delegation signed via daemon');
  assert(
    typeof grant.delegation.id === 'string',
    `delegation id: ${grant.delegation.id.slice(0, 20)}...`,
  );

  const grants = await callVat(socketPath, rootKref, 'listGrants');
  assert(grants.length === 1, 'one grant listed via daemon');

  // -----------------------------------------------------------------------
  // Test 7: Get capabilities via daemon
  // -----------------------------------------------------------------------

  console.log('\n--- Capabilities via daemon ---');
  const caps = await callVat(socketPath, rootKref, 'getCapabilities');
  assert(caps.hasLocalKeys === true, 'has local keys');
  assert(caps.delegationCount === 1, 'one delegation');
  assert(caps.hasPeerWallet === false, 'no peer wallet');
  assert(caps.localAccounts.length === 1, 'one account');

  // -----------------------------------------------------------------------
  // Test 8: Verify vats are visible in daemon status
  // -----------------------------------------------------------------------

  console.log('\n--- Verify wallet vats in daemon status ---');
  const statusAfter = await rpc(socketPath, 'getStatus');
  const { vats } = statusAfter.result;
  assert(vats.length >= 4, `at least 4 vats running (got ${vats.length})`);

  // -----------------------------------------------------------------------
  // Test 9: No-authority error surfaces through daemon
  // -----------------------------------------------------------------------

  console.log('\n--- Error handling via daemon ---');
  // Launch second wallet, don't init keyring
  const launch2 = await rpc(socketPath, 'launchSubcluster', {
    config: makeWalletClusterConfig({ bundleBaseUrl: BUNDLE_BASE_URL }),
  });
  await waitUntilQuiescent();
  const coord2 = launch2.result.rootKref;

  const errorBody = await callVatExpectError(
    socketPath,
    coord2,
    'signMessage',
    ['should fail'],
  );
  assert(errorBody.includes('No authority'), 'error surfaces through daemon');

  // -----------------------------------------------------------------------
  // Test 10: Terminate subcluster via daemon
  // -----------------------------------------------------------------------

  console.log('\n--- Terminate subcluster via daemon ---');
  const termResp = await rpc(socketPath, 'terminateSubcluster', {
    id: subclusterId,
  });
  assert(termResp.error === undefined, 'terminateSubcluster succeeds');

  // Verify it's gone
  const statusFinal = await rpc(socketPath, 'getStatus');
  const remainingSubclusters = statusFinal.result.subclusters || [];
  const found = remainingSubclusters.find((sc) => sc.id === subclusterId);
  assert(!found, 'subcluster removed after termination');

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  console.log('\n--- Cleanup ---');
  await rpcServer.close();
  try {
    await kernel.stop();
  } catch {
    // Ignore stop errors
  }
  kernelDb.close();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
