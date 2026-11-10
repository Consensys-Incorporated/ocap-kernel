/* oxlint-disable jsdoc/require-param-description, jsdoc/require-returns-description, no-plusplus */
/**
 * Plain Node.js integration test for the evm-wallet subcluster.
 *
 * Bypasses vitest to avoid SES/vitest interactions. Runs under real SES
 * lockdown, creates a real kernel, launches the wallet subcluster, and
 * exercises the wallet API via queueMessage.
 *
 * Usage:
 *   yarn workspace @ocap/evm-wallet-experiment test:node
 */

// SES lockdown must be the first thing that runs.
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

// Derived address for index 0 of the "test test ... junk" mnemonic
const EXPECTED_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/**
 * @param {boolean} condition
 * @param {string} label
 */
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

/**
 * @param {Kernel} kernel
 * @param {string} target
 * @param {string} method
 * @param {unknown[]} args
 * @returns {Promise<unknown>}
 */
async function call(kernel, target, method, args = []) {
  const result = await kernel.queueMessage(target, method, args);
  await waitUntilQuiescent();
  return kunser(result);
}

/**
 * @param {Kernel} kernel
 * @param {string} target
 * @param {string} method
 * @param {unknown[]} args
 * @returns {Promise<string>}
 */
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

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== ETH Wallet Subcluster Integration Test ===\n');

  console.log('Setting up kernel...');
  const kernelDb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const platformServices = new NodejsPlatformServices({});
  const kernel = await Kernel.make(platformServices, kernelDb, {
    resetStorage: true,
  });

  console.log('Launching wallet subcluster...');
  const walletConfig = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
  });

  let coordinatorKref;
  try {
    const result = await kernel.launchSubcluster(walletConfig);
    await waitUntilQuiescent();
    coordinatorKref = result.rootKref;
    console.log(
      `Wallet subcluster launched. Coordinator: ${coordinatorKref}\n`,
    );
  } catch (error) {
    console.error('FATAL: Failed to launch wallet subcluster:', error.message);
    kernelDb.close();
    process.exit(1);
  }

  // -- Capabilities before init --
  console.log('--- Capabilities (before init) ---');
  const capsBefore = await call(kernel, coordinatorKref, 'getCapabilities');
  assert(capsBefore.hasLocalKeys === false, 'no local keys before init');
  assert(
    Array.isArray(capsBefore.localAccounts) &&
      capsBefore.localAccounts.length === 0,
    'no accounts before init',
  );
  assert(capsBefore.delegationCount === 0, 'no delegations before init');
  assert(capsBefore.hasPeerWallet === false, 'no peer wallet');
  assert(capsBefore.hasExternalSigner === false, 'no external signer');

  // -- Initialize keyring with SRP --
  console.log('\n--- Initialize keyring (SRP) ---');
  await call(kernel, coordinatorKref, 'initializeKeyring', [
    { type: 'srp', mnemonic: TEST_MNEMONIC },
  ]);
  console.log('  Keyring initialized.');

  const accounts = await call(kernel, coordinatorKref, 'getAccounts');
  assert(Array.isArray(accounts), 'getAccounts returns array');
  assert(accounts.length === 1, 'one account derived');
  assert(
    accounts[0].toLowerCase() === EXPECTED_ADDRESS,
    `correct address: ${accounts[0]}`,
  );

  // -- Capabilities after init --
  console.log('\n--- Capabilities (after init) ---');
  const capsAfter = await call(kernel, coordinatorKref, 'getCapabilities');
  assert(capsAfter.hasLocalKeys === true, 'has local keys after init');
  assert(capsAfter.localAccounts.length === 1, 'one account');
  assert(capsAfter.delegationCount === 0, 'still no delegations');

  // -- Sign message (EIP-191) --
  console.log('\n--- Sign message ---');
  const message = 'Hello from the wallet subcluster!';
  const msgSig = await call(kernel, coordinatorKref, 'signMessage', [message]);
  assert(typeof msgSig === 'string', 'signature is a string');
  assert(msgSig.startsWith('0x'), 'signature starts with 0x');
  assert(msgSig.length === 132, `signature is 65 bytes (got ${msgSig.length})`);

  // -- Sign transaction --
  console.log('\n--- Sign transaction ---');
  const tx = {
    from: accounts[0],
    to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    value: '0xde0b6b3a7640000',
    chainId: 1,
    nonce: 0,
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
  };
  const signedTx = await call(kernel, coordinatorKref, 'signTransaction', [tx]);
  assert(typeof signedTx === 'string', 'signed tx is a string');
  assert(signedTx.startsWith('0x'), 'signed tx starts with 0x');
  assert(
    signedTx.length > 100,
    `signed tx is non-trivial (${signedTx.length} chars)`,
  );

  // -- Sign typed data (EIP-712) --
  console.log('\n--- Sign typed data (EIP-712) ---');
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
  const typedSig = await call(kernel, coordinatorKref, 'signTypedData', [
    typedData,
  ]);
  assert(typeof typedSig === 'string', 'typed data sig is a string');
  assert(typedSig.startsWith('0x'), 'typed data sig starts with 0x');
  assert(
    typedSig.length === 132,
    `typed data sig is 65 bytes (got ${typedSig.length})`,
  );

  // -- Build delegation grant --
  console.log('\n--- Build delegation grant ---');
  const grant = await call(
    kernel,
    coordinatorKref,
    'buildTransferNativeGrant',
    [
      {
        delegate: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        chainId: 1,
      },
    ],
  );
  assert(typeof grant === 'object' && grant !== null, 'grant is an object');
  assert(typeof grant.delegation.id === 'string', 'delegation has an id');
  assert(grant.delegation.status === 'signed', 'delegation is signed');
  assert(
    grant.delegation.signature.startsWith('0x'),
    'delegation has a signature',
  );
  assert(
    grant.delegation.delegator.toLowerCase() === accounts[0].toLowerCase(),
    'delegator is our account',
  );
  assert(
    grant.delegation.delegate.toLowerCase() ===
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    'delegate matches',
  );

  // -- List grants --
  console.log('\n--- List grants ---');
  const grants = await call(kernel, coordinatorKref, 'listGrants');
  assert(Array.isArray(grants), 'listGrants returns array');
  assert(grants.length === 1, 'one grant');
  assert(grants[0].delegation.id === grant.delegation.id, 'correct grant');

  // -- No authority error --
  console.log('\n--- No authority error ---');
  const walletConfig2 = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
  });
  const result2 = await kernel.launchSubcluster(walletConfig2);
  await waitUntilQuiescent();
  const coordinator2 = result2.rootKref;
  const signError = await callExpectError(kernel, coordinator2, 'signMessage', [
    'should fail',
  ]);
  assert(
    signError instanceof Error && signError.message.includes('No authority'),
    'error when no authority to sign',
  );

  // -- Throwaway key --
  console.log('\n--- Throwaway key ---');
  await call(kernel, coordinator2, 'initializeKeyring', [
    { type: 'throwaway' },
  ]);
  const throwawayAccounts = await call(kernel, coordinator2, 'getAccounts');
  assert(throwawayAccounts.length === 1, 'throwaway key produces one account');
  assert(
    throwawayAccounts[0].startsWith('0x'),
    `throwaway address: ${throwawayAccounts[0]}`,
  );
  assert(
    throwawayAccounts[0].toLowerCase() !== EXPECTED_ADDRESS,
    'throwaway is different from SRP-derived',
  );
  const throwSig = await call(kernel, coordinator2, 'signMessage', [
    'hello from throwaway',
  ]);
  assert(throwSig.length === 132, 'throwaway can sign messages');

  // -- Cleanup --
  console.log('\n--- Cleanup ---');
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
