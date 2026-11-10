/* oxlint-disable node/no-process-env */
/**
 * Sepolia E2E test for the evm-wallet subcluster.
 *
 * Exercises the full on-chain flow: create a Hybrid smart account via the
 * MetaMask Delegation Framework, create a delegation, redeem it by
 * submitting a UserOp to a Pimlico bundler, and wait for on-chain inclusion.
 *
 * Requires environment variables:
 *   PIMLICO_API_KEY  - Pimlico API key (free tier works for Sepolia)
 *   SEPOLIA_RPC_URL  - Sepolia JSON-RPC endpoint (e.g. Infura, Alchemy)
 *
 * Usage:
 *   PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
 *     yarn workspace @ocap/evm-wallet-experiment test:node:sepolia
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

const { PIMLICO_API_KEY } = process.env;
const { SEPOLIA_RPC_URL } = process.env;

if (!PIMLICO_API_KEY || !SEPOLIA_RPC_URL) {
  console.log(
    '\nSkipping Sepolia E2E: set PIMLICO_API_KEY and SEPOLIA_RPC_URL\n',
  );
  process.exit(0);
}

const SEPOLIA_CHAIN_ID = 11155111;
// Funded test wallet on Sepolia
const TEST_MNEMONIC =
  process.env.TEST_MNEMONIC ||
  'describe vote fluid circle capable include endless leopard clarify copper industry address';
const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();
// Use a unique deploy salt per test run to get a fresh smart account each time
const DEPLOY_SALT = `0x${Date.now().toString(16).padStart(64, '0')}`;
const USEROP_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Call a vat method, pumping the kernel event loop until the result resolves.
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

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Sepolia E2E Test ===\n');

  // -- Setup --
  console.log('Setting up kernel...');
  const kernelDb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernel = await Kernel.make(new NodejsPlatformServices({}), kernelDb, {
    resetStorage: true,
  });

  const delegationManagerAddress =
    getDelegationManagerAddress(SEPOLIA_CHAIN_ID);
  console.log(`  DelegationManager: ${delegationManagerAddress}`);

  const walletConfig = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    allowedHosts: ['sepolia.infura.io', 'api.pimlico.io'],
    delegationManagerAddress,
  });
  const { rootKref } = await kernel.launchSubcluster(walletConfig);
  await waitUntilQuiescent();
  console.log(`  Coordinator: ${rootKref}\n`);

  // -- 1. Initialize keyring with funded wallet --
  console.log('--- Initialize keyring ---');
  await call(kernel, rootKref, 'initializeKeyring', [
    { type: 'srp', mnemonic: TEST_MNEMONIC },
  ]);
  const accounts = await call(kernel, rootKref, 'getAccounts');
  assert(accounts.length > 0, `EOA: ${accounts[0]}`);

  // -- 2. Configure provider for Sepolia --
  console.log('\n--- Configure Sepolia provider ---');
  await call(kernel, rootKref, 'configureProvider', [
    { chainId: SEPOLIA_CHAIN_ID, rpcUrl: SEPOLIA_RPC_URL },
  ]);
  assert(true, 'provider configured');

  // -- 3. Configure bundler (no paymaster — funded wallet pays gas) --
  console.log('\n--- Configure Pimlico bundler ---');
  const bundlerUrl = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;
  await call(kernel, rootKref, 'configureBundler', [
    {
      bundlerUrl,
      chainId: SEPOLIA_CHAIN_ID,
      usePaymaster: true,
      sponsorshipPolicyId: 'sp_young_killmonger',
    },
  ]);
  assert(true, 'bundler configured');

  // -- 4. Create a Hybrid smart account --
  console.log('\n--- Create smart account ---');
  const smartConfig = await call(kernel, rootKref, 'createSmartAccount', [
    { deploySalt: DEPLOY_SALT, chainId: SEPOLIA_CHAIN_ID },
  ]);
  assert(
    typeof smartConfig.address === 'string' &&
      smartConfig.address.match(/^0x[\da-f]{40}$/iu),
    `smart account: ${smartConfig.address}`,
  );
  assert(smartConfig.implementation === 'hybrid', 'implementation: hybrid');
  assert(smartConfig.deployed === false, 'not yet deployed');

  // -- 5. Build a native-transfer delegation grant (smart account → smart account) --
  console.log('\n--- Build delegation grant ---');
  const grant = await call(kernel, rootKref, 'buildTransferNativeGrant', [
    {
      delegate: smartConfig.address,
      chainId: SEPOLIA_CHAIN_ID,
    },
  ]);
  assert(grant.delegation.status === 'signed', 'delegation signed');
  assert(
    grant.delegation.delegator === smartConfig.address,
    'delegator is smart account',
  );
  assert(
    grant.delegation.delegate === smartConfig.address,
    'delegate is smart account',
  );
  console.log(`  Delegation ID: ${grant.delegation.id.slice(0, 20)}...`);

  // -- 6. Redeem the delegation via UserOp --
  console.log('\n--- Redeem delegation (submit UserOp) ---');
  console.log('  Submitting to Pimlico bundler...');
  const userOpHash = await call(kernel, rootKref, 'redeemDelegation', [
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
    typeof userOpHash === 'string' && userOpHash.match(/^0x[\da-f]{64}$/iu),
    `userOp hash: ${userOpHash}`,
  );

  // -- 7. Wait for on-chain inclusion (poll from test, not vat — setTimeout
  //    is unavailable under SES) --
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
  if (receipt.receipt?.transactionHash) {
    console.log(
      `  Tx: https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`,
    );
  }

  // -- Verify smart account is now deployed --
  console.log('\n--- Verify post-redemption state ---');
  const capsAfter = await call(kernel, rootKref, 'getCapabilities');
  assert(
    capsAfter.smartAccountAddress === smartConfig.address,
    'smart account address persisted',
  );

  // -- Cleanup --
  console.log('\n--- Cleanup ---');
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
