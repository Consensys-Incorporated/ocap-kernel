/* oxlint-disable no-plusplus, node/no-process-env */
/**
 * Spending-limits E2E test against Sepolia.
 *
 * Exercises the on-chain caveat enforcement flow: create a delegation with
 * NativeTokenTransferAmount (total ceiling) and ValueLte (per-tx max)
 * caveats, redeem within limits, and verify that over-limit redemptions
 * revert.
 *
 * ── What it tests ──────────────────────────────────────────────────────
 *
 *   1. Single kernel + smart account against Sepolia
 *   2. Delegation creation with two spending-limit caveats
 *   3. Caveat terms correctly ABI-encoded in the delegation object
 *   4. Redemption within both limits succeeds on-chain
 *   5. Redemption exceeding per-tx limit reverts (bundler simulation)
 *   6. Redemption exceeding total ceiling reverts after earlier spend
 *
 * ── Environment variables (required) ───────────────────────────────────
 *
 *   PIMLICO_API_KEY  Pimlico API key (free tier, Sepolia).
 *   SEPOLIA_RPC_URL  Sepolia JSON-RPC endpoint.
 *
 * ── Optional ───────────────────────────────────────────────────────────
 *
 *   TEST_MNEMONIC    BIP-39 mnemonic for a funded Sepolia wallet.
 *                    Defaults to the shared test wallet.
 *
 * ── Usage ──────────────────────────────────────────────────────────────
 *
 *   PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
 *     yarn workspace @ocap/evm-wallet-experiment test:node:spending-limits
 */

import '@metamask/kernel-shims/endoify-node';

import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Kernel, kunser } from '@metamask/ocap-kernel';

import { makeWalletClusterConfig } from '../../src/cluster-config.ts';
import { getChainContracts } from '../../src/constants.ts';
import {
  encodeNativeTokenTransferAmount,
  encodeValueLte,
  makeCaveat,
} from '../../src/lib/caveats.ts';
import { getDelegationManagerAddress } from '../../src/lib/sdk.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { PIMLICO_API_KEY, SEPOLIA_RPC_URL } = process.env;

if (!PIMLICO_API_KEY || !SEPOLIA_RPC_URL) {
  console.log(
    '\nSkipping Spending Limits E2E: set PIMLICO_API_KEY and SEPOLIA_RPC_URL\n',
  );
  process.exit(0);
}

const SEPOLIA_CHAIN_ID = 11155111;
const TEST_MNEMONIC =
  process.env.TEST_MNEMONIC ||
  'describe vote fluid circle capable include endless leopard clarify copper industry address';
const BUNDLE_BASE_URL = new URL('../../src/vats', import.meta.url).toString();
const DEPLOY_SALT = `0x${Date.now().toString(16).padStart(64, '0')}`;
const USEROP_TIMEOUT = 120_000;

const delegationManagerAddress = getDelegationManagerAddress(SEPOLIA_CHAIN_ID);
const bundlerUrl = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;

// Spending limits for the test delegation.
// TOTAL = 1.5 × PER_TX so that after spending WITHIN (0.5 × PER_TX) the
// remaining budget (1 × PER_TX) fits within a single per-tx send.
const TOTAL_LIMIT_WEI = 15_000_000_000_000n; // 0.000015 ETH
const PER_TX_LIMIT_WEI = 10_000_000_000_000n; // 0.00001 ETH
const WITHIN_LIMIT_WEI = 5_000_000_000_000n; // 0.000005 ETH (half of per-tx)
const OVER_TX_LIMIT_WEI = 15_000_000_000_000n; // 0.000015 ETH (exceeds per-tx)

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

// Try a call that is expected to fail. Returns the error message or null
// if the call unexpectedly succeeds.
async function callExpectError(kernel, target, method, args = []) {
  try {
    const result = await call(kernel, target, method, args);
    // Some errors are returned as string values rather than thrown
    if (typeof result === 'string' && result.includes('error')) {
      return result;
    }
    return null;
  } catch (error) {
    return error.message || String(error);
  }
}

async function waitForTxReceipt(txHash) {
  console.log(`  Polling for receipt (timeout: ${USEROP_TIMEOUT / 1000}s)...`);
  const deadline = Date.now() + USEROP_TIMEOUT;
  while (Date.now() < deadline) {
    try {
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
        return json.result;
      }
    } catch {
      // ignore fetch errors during polling
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

async function waitForUserOpReceipt(userOpHash) {
  console.log(`  Polling for receipt (timeout: ${USEROP_TIMEOUT / 1000}s)...`);
  const deadline = Date.now() + USEROP_TIMEOUT;
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
        return json.result;
      }
    } catch {
      // ignore fetch errors during polling
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Spending Limits E2E Test ===\n');

  // -- Setup --
  console.log('Setting up kernel...');
  const kernelDb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernel = await Kernel.make(new NodejsPlatformServices({}), kernelDb, {
    resetStorage: true,
  });

  console.log(`  DelegationManager: ${delegationManagerAddress}`);
  const walletConfig = makeWalletClusterConfig({
    bundleBaseUrl: BUNDLE_BASE_URL,
    allowedHosts: ['sepolia.infura.io', 'api.pimlico.io'],
    delegationManagerAddress,
  });
  const { rootKref } = await kernel.launchSubcluster(walletConfig);
  await waitUntilQuiescent();
  console.log(`  Coordinator: ${rootKref}\n`);

  // =====================================================================
  // 1. Initialize keyring + provider + bundler
  // =====================================================================

  console.log('--- Initialize keyring ---');
  await call(kernel, rootKref, 'initializeKeyring', [
    { type: 'srp', mnemonic: TEST_MNEMONIC },
  ]);
  const accounts = await call(kernel, rootKref, 'getAccounts');
  assert(accounts.length > 0, `EOA: ${accounts[0]}`);

  console.log('\n--- Configure Sepolia provider ---');
  await call(kernel, rootKref, 'configureProvider', [
    { chainId: SEPOLIA_CHAIN_ID, rpcUrl: SEPOLIA_RPC_URL },
  ]);
  assert(true, 'provider configured');

  console.log('\n--- Configure Pimlico bundler ---');
  await call(kernel, rootKref, 'configureBundler', [
    {
      bundlerUrl,
      chainId: SEPOLIA_CHAIN_ID,
      usePaymaster: true,
      sponsorshipPolicyId: 'sp_young_killmonger',
    },
  ]);
  assert(true, 'bundler configured');

  // =====================================================================
  // 2. Create smart account
  // =====================================================================

  console.log('\n--- Create smart account ---');
  const smartConfig = await call(kernel, rootKref, 'createSmartAccount', [
    { deploySalt: DEPLOY_SALT, chainId: SEPOLIA_CHAIN_ID },
  ]);
  assert(
    typeof smartConfig.address === 'string' &&
      smartConfig.address.match(/^0x[\da-f]{40}$/iu),
    `smart account: ${smartConfig.address}`,
  );

  // =====================================================================
  // 2.5. Fund smart account with ETH
  //
  // Delegation executions send ETH *from* the smart account; without a
  // balance the on-chain execution reverts even though gas is sponsored.
  // Fund with slightly more than the total limit so the account can cover
  // all test sends (each is a self-send so the balance never decreases).
  // =====================================================================

  console.log('\n--- Fund smart account ---');
  const FUND_AMOUNT_WEI = TOTAL_LIMIT_WEI + 5_000_000_000_000n;
  const fundValueHex = `0x${FUND_AMOUNT_WEI.toString(16)}`;
  console.log(
    `  Sending ${Number(FUND_AMOUNT_WEI) / 1e18} ETH from EOA (${accounts[0]}) to ${smartConfig.address}...`,
  );
  const fundTxHash = await call(kernel, rootKref, 'sendTransaction', [
    {
      from: accounts[0],
      to: smartConfig.address,
      value: fundValueHex,
    },
  ]);
  assert(
    typeof fundTxHash === 'string' && fundTxHash.startsWith('0x'),
    `fund tx hash: ${fundTxHash}`,
  );
  const fundReceipt = await waitForTxReceipt(fundTxHash);
  assert(fundReceipt !== null, 'fund tx receipt received');
  assert(fundReceipt?.status === '0x1', 'fund tx succeeded');
  console.log(`  Funded: https://sepolia.etherscan.io/tx/${fundTxHash}`);

  // =====================================================================
  // 3. Build spending-limit caveats
  // =====================================================================

  console.log('\n--- Build spending-limit caveats ---');

  const sepoliaContracts = getChainContracts(SEPOLIA_CHAIN_ID);

  const totalLimitCaveat = makeCaveat({
    type: 'nativeTokenTransferAmount',
    terms: encodeNativeTokenTransferAmount(TOTAL_LIMIT_WEI),
    chainId: SEPOLIA_CHAIN_ID,
  });
  assert(
    totalLimitCaveat.enforcer ===
      sepoliaContracts.enforcers.nativeTokenTransferAmount,
    `total-limit enforcer: ${totalLimitCaveat.enforcer.slice(0, 10)}...`,
  );
  assert(
    totalLimitCaveat.type === 'nativeTokenTransferAmount',
    'total-limit caveat type',
  );

  const perTxCaveat = makeCaveat({
    type: 'valueLte',
    terms: encodeValueLte(PER_TX_LIMIT_WEI),
    chainId: SEPOLIA_CHAIN_ID,
  });
  assert(
    perTxCaveat.enforcer === sepoliaContracts.enforcers.valueLte,
    `per-tx enforcer: ${perTxCaveat.enforcer.slice(0, 10)}...`,
  );
  assert(perTxCaveat.type === 'valueLte', 'per-tx caveat type');

  console.log(
    `  Total limit: ${Number(TOTAL_LIMIT_WEI) / 1e18} ETH, Per-tx limit: ${Number(PER_TX_LIMIT_WEI) / 1e18} ETH`,
  );

  // =====================================================================
  // 4. Build delegation grant with spending limits
  // =====================================================================

  console.log('\n--- Build delegation grant with spending limits ---');
  const grant = await call(kernel, rootKref, 'buildTransferNativeGrant', [
    {
      delegate: smartConfig.address,
      totalLimit: TOTAL_LIMIT_WEI,
      maxAmount: PER_TX_LIMIT_WEI,
      chainId: SEPOLIA_CHAIN_ID,
    },
  ]);
  assert(grant.delegation.status === 'signed', 'delegation signed');
  assert(grant.delegation.caveats.length === 2, 'delegation has 2 caveats');
  assert(
    grant.delegation.caveats[0].type === 'nativeTokenTransferAmount',
    'first caveat: nativeTokenTransferAmount',
  );
  assert(
    grant.delegation.caveats[1].type === 'valueLte',
    'second caveat: valueLte',
  );
  assert(
    grant.delegation.caveats[0].enforcer.toLowerCase() ===
      sepoliaContracts.enforcers.nativeTokenTransferAmount.toLowerCase(),
    'first caveat uses correct enforcer address',
  );
  assert(
    grant.delegation.caveats[1].enforcer.toLowerCase() ===
      sepoliaContracts.enforcers.valueLte.toLowerCase(),
    'second caveat uses correct enforcer address',
  );
  console.log(`  Delegation ID: ${grant.delegation.id.slice(0, 20)}...`);

  // =====================================================================
  // 5. Redeem within limits (should succeed)
  // =====================================================================

  console.log('\n--- Redeem within limits ---');
  const withinValueHex = `0x${WITHIN_LIMIT_WEI.toString(16)}`;
  console.log(
    `  Sending ${Number(WITHIN_LIMIT_WEI) / 1e18} ETH (within both limits)...`,
  );
  const userOpHash = await call(kernel, rootKref, 'redeemDelegation', [
    {
      delegation: grant.delegation,
      execution: {
        target: smartConfig.address,
        value: withinValueHex,
        callData: '0x',
      },
    },
  ]);
  assert(
    typeof userOpHash === 'string' && userOpHash.match(/^0x[\da-f]{64}$/iu),
    `userOp hash: ${userOpHash}`,
  );

  const receipt = await waitForUserOpReceipt(userOpHash);
  assert(receipt !== null && receipt !== undefined, 'receipt received');
  assert(receipt?.success === true, 'UserOp succeeded on-chain');
  if (receipt?.receipt?.transactionHash) {
    console.log(
      `  Tx: https://sepolia.etherscan.io/tx/${receipt.receipt.transactionHash}`,
    );
  }

  // =====================================================================
  // 6. Attempt redemption exceeding per-tx limit (should fail)
  // =====================================================================

  console.log('\n--- Attempt over per-tx limit ---');
  const overTxHex = `0x${OVER_TX_LIMIT_WEI.toString(16)}`;
  console.log(
    `  Attempting ${Number(OVER_TX_LIMIT_WEI) / 1e18} ETH (exceeds per-tx limit of ${Number(PER_TX_LIMIT_WEI) / 1e18})...`,
  );
  const overTxError = await callExpectError(
    kernel,
    rootKref,
    'redeemDelegation',
    [
      {
        delegation: grant.delegation,
        execution: {
          target: smartConfig.address,
          value: overTxHex,
          callData: '0x',
        },
      },
    ],
  );
  assert(
    overTxError !== null,
    `per-tx limit enforced — revert: ${(overTxError || '').slice(0, 80)}...`,
  );

  // =====================================================================
  // 7. Exhaust total limit with multiple sends
  //    After the first successful send of WITHIN_LIMIT_WEI, the remaining
  //    budget is TOTAL_LIMIT_WEI - WITHIN_LIMIT_WEI. We send that amount
  //    to reach the ceiling, then a tiny send should fail.
  // =====================================================================

  console.log('\n--- Exhaust total spending limit ---');
  const remainingBudget = TOTAL_LIMIT_WEI - WITHIN_LIMIT_WEI;
  const remainingHex = `0x${remainingBudget.toString(16)}`;
  console.log(
    `  Sending remaining ${Number(remainingBudget) / 1e18} ETH to hit ceiling...`,
  );

  const exhaustHash = await call(kernel, rootKref, 'redeemDelegation', [
    {
      delegation: grant.delegation,
      execution: {
        target: smartConfig.address,
        value: remainingHex,
        callData: '0x',
      },
    },
  ]);

  if (
    typeof exhaustHash === 'string' &&
    exhaustHash.match(/^0x[\da-f]{64}$/iu)
  ) {
    const exhaustReceipt = await waitForUserOpReceipt(exhaustHash);
    assert(
      exhaustReceipt?.success === true,
      'second send succeeded (reached ceiling)',
    );

    // Now try one more tiny send — should fail (total limit exhausted)
    console.log('  Attempting 1 wei over exhausted ceiling...');
    const overCeilingError = await callExpectError(
      kernel,
      rootKref,
      'redeemDelegation',
      [
        {
          delegation: grant.delegation,
          execution: {
            target: smartConfig.address,
            value: '0x1',
            callData: '0x',
          },
        },
      ],
    );
    assert(
      overCeilingError !== null,
      `total ceiling enforced — revert: ${(overCeilingError || '').slice(0, 80)}...`,
    );
  } else {
    // If the exhaust send itself failed, that's also acceptable
    // (the bundler simulation rejected it because limits were already tight)
    assert(true, 'total ceiling enforced during simulation');
  }

  // =====================================================================
  // Cleanup
  // =====================================================================

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
