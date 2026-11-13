/* oxlint-disable node/no-process-env */
/**
 * Sepolia E2E: stateless7702 delegation redemption via direct EIP-1559 tx (no bundler).
 *
 * Requires:
 *   SEPOLIA_RPC_URL  - Sepolia JSON-RPC (e.g. Infura)
 *   TEST_MNEMONIC    - Funded mnemonic (defaults to same env as run-sepolia-e2e)
 *
 * Does not use Pimlico. Skips when SEPOLIA_RPC_URL is unset.
 *
 * Usage:
 *   SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx TEST_MNEMONIC="..." \
 *     yarn workspace @ocap/evm-wallet-experiment test:node:sepolia-7702-direct
 */

import '@metamask/kernel-shims/endoify-node';

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Kernel, kunser } from '@metamask/ocap-kernel';

import { makeWalletClusterConfig } from '../../src/cluster-config.ts';
import { getDelegationManagerAddress } from '../../src/lib/sdk.ts';

const { SEPOLIA_RPC_URL } = process.env;

if (!SEPOLIA_RPC_URL) {
  console.log('\nSkipping 7702 direct E2E: set SEPOLIA_RPC_URL\n');
  process.exit(0);
}

const SEPOLIA_CHAIN_ID = 11155111;
const TEST_MNEMONIC =
  process.env.TEST_MNEMONIC ||
  'describe vote fluid circle capable include endless leopard clarify copper industry address';

const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();
const TX_TIMEOUT_MS = 120_000;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function call(
  kernel,
  target,
  method,
  args = [],
  timeout = TX_TIMEOUT_MS,
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

async function main() {
  console.log('\n=== Sepolia E2E: 7702 direct (no bundler) ===\n');

  const rpcHost = new URL(SEPOLIA_RPC_URL).hostname;

  const kernelDb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernel = await Kernel.make(new NodejsPlatformServices({}), kernelDb, {
    resetStorage: true,
  });

  const delegationManagerAddress =
    getDelegationManagerAddress(SEPOLIA_CHAIN_ID);

  const walletConfig = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    allowedHosts: [rpcHost],
    delegationManagerAddress,
  });
  const { rootKref } = await kernel.launchSubcluster(walletConfig);
  await waitUntilQuiescent();

  await call(kernel, rootKref, 'initializeKeyring', [
    { type: 'srp', mnemonic: TEST_MNEMONIC },
  ]);
  const accounts = await call(kernel, rootKref, 'getAccounts');
  assert(accounts.length > 0, `EOA: ${accounts[0]}`);

  await call(kernel, rootKref, 'configureProvider', [
    { chainId: SEPOLIA_CHAIN_ID, rpcUrl: SEPOLIA_RPC_URL },
  ]);
  assert(true, 'provider configured');

  // 7702 upgrade (broadcasts auth tx; waits for receipt inside vat)
  console.log('\n--- Create stateless7702 smart account ---');
  const smartConfig = await call(
    kernel,
    rootKref,
    'createSmartAccount',
    [{ chainId: SEPOLIA_CHAIN_ID, implementation: 'stateless7702' }],
    180_000,
  );
  assert(
    smartConfig.implementation === 'stateless7702',
    'implementation: stateless7702',
  );
  assert(accounts[0] === smartConfig.address, 'same address as EOA');

  const grant = await call(kernel, rootKref, 'buildTransferNativeGrant', [
    {
      delegate: smartConfig.address,
      chainId: SEPOLIA_CHAIN_ID,
    },
  ]);
  assert(grant.delegation.status === 'signed', 'delegation signed');

  console.log('\n--- Redeem via direct tx (no bundler) ---');
  const txHash = await call(kernel, rootKref, 'redeemDelegation', [
    {
      delegation: grant.delegation,
      execution: {
        target: smartConfig.address,
        value: '0x0',
        callData: '0x',
      },
    },
  ]);
  assert(
    typeof txHash === 'string' && txHash.match(/^0x[\da-f]{64}$/iu),
    `tx hash: ${txHash}`,
  );

  console.log(
    `\n--- Poll eth_getTransactionReceipt (${TX_TIMEOUT_MS / 1000}s max) ---`,
  );
  const deadline = Date.now() + TX_TIMEOUT_MS;
  let mined = null;
  while (Date.now() < deadline) {
    const resp = await fetch(SEPOLIA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });
    const json = await resp.json();
    if (json.result) {
      mined = json.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert(mined !== null && mined.status === '0x1', 'tx succeeded on-chain');

  try {
    await kernel.stop();
  } catch {
    // ignore
  }
  kernelDb.close();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
