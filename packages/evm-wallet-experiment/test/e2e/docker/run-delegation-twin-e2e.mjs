/* oxlint-disable no-plusplus */
/**
 * Delegation-twin E2E test — runs **inside** the away container.
 *
 * Exercises the delegation twin as a live exo capability by calling the
 * home coordinator to build a signed grant, sending it to the away
 * coordinator via receiveDelegation, and then calling transferFungible
 * through the away coordinator (which routes via the delegation twin).
 *
 * ── What it tests ─────────────────────────────────────────────────────────
 *
 *   1. Home builds a transfer-fungible grant (max spend = 5 units, fake token).
 *   2. Away receives the grant and rebuilds the delegation routing.
 *   3. Away calls transferFungible(3) → twin succeeds (3 ≤ 5 remaining).
 *   4. Away calls transferFungible(3) again → twin rejects LOCALLY
 *      ("Insufficient budget") before any network call is made.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   Invoked by docker-e2e.test.ts via dockerExec:
 *
 *     node --conditions development run-delegation-twin-e2e.mjs \
 *       <mode> <homeKref> <awayKref> <delegateAddress>
 *
 *   mode            bundler-7702 | bundler-hybrid | peer-relay
 *   homeKref        coordinator kref on the home kernel (e.g. ko4)
 *   awayKref        coordinator kref on the away kernel
 *   delegateAddress on-chain delegate address for the delegation
 */

import '@metamask/kernel-shims/endoify-node';

import { readFile } from 'node:fs/promises';

import { makeDaemonClient } from './helpers/daemon-client.mjs';

const [, , mode, homeKref, awayKref, delegateAddress] = process.argv;

if (!mode || !homeKref || !awayKref || !delegateAddress) {
  console.error(
    'Usage: run-delegation-twin-e2e.mjs <mode> <homeKref> <awayKref> <delegateAddress>',
  );
  process.exit(1);
}

const SERVICE_PAIRS = {
  'bundler-7702': {
    home: 'kernel-home-bundler-7702',
    away: 'kernel-away-bundler-7702',
  },
  'bundler-hybrid': {
    home: 'kernel-home-bundler-hybrid',
    away: 'kernel-away-bundler-hybrid',
  },
  'peer-relay': {
    home: 'kernel-home-peer-relay',
    away: 'kernel-away-peer-relay',
  },
};

const pair = SERVICE_PAIRS[mode];
if (!pair) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const homeReady = JSON.parse(
  await readFile(`/run/ocap/${pair.home}-ready.json`, 'utf8'),
);
const awayReady = JSON.parse(
  await readFile(`/run/ocap/${pair.away}-ready.json`, 'utf8'),
);

const homeClient = makeDaemonClient(homeReady.socketPath);
const awayClient = makeDaemonClient(awayReady.socketPath);

// Zero-code address on Anvil — EVM calls to it succeed with empty return.
// The erc20TransferAmount enforcer only inspects calldata amount, not the
// token contract itself, so this works as a stand-in token.
const FAKE_TOKEN = '0x000000000000000000000000000000000000dEaD';
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const CHAIN_ID = 31337;

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

console.log(`\n=== Delegation Twin E2E (${mode}) ===\n`);

// ── Test: Twin enforces cumulative spend locally ───────────────────────────

console.log('--- Transfer twin: spend tracking ---');

// Home builds and signs the grant. totalLimit is a string because JSON cannot
// carry BigInt; buildTransferFungibleGrant coerces it back to BigInt.
const signedGrant = await homeClient.callVat(
  homeKref,
  'buildTransferFungibleGrant',
  [
    {
      delegate: delegateAddress,
      token: FAKE_TOKEN,
      totalLimit: '5',
      chainId: CHAIN_ID,
    },
  ],
);

assert(
  signedGrant !== null && typeof signedGrant === 'object',
  'home built and signed transfer-fungible grant',
);

// Away receives the grant: redeemer vat stores it, routing is rebuilt
// with a delegation twin that enforces the 5-unit budget.
await awayClient.callVat(awayKref, 'receiveDelegation', [signedGrant]);

assert(true, 'away received delegation and rebuilt routing');

// First spend: 3 ≤ 5 remaining → should reach the chain and succeed.
console.log('  Calling transferFungible(3) — should hit chain...');
const txHash = await awayClient.callVat(awayKref, 'transferFungible', [
  FAKE_TOKEN,
  BURN_ADDRESS,
  '3',
]);

// For bundler-hybrid, wait for on-chain UserOp inclusion.
if (mode === 'bundler-hybrid') {
  console.log('  Waiting for UserOp receipt (hybrid mode)...');
  await awayClient.callVat(awayKref, 'waitForUserOpReceipt', [
    { userOpHash: txHash, pollIntervalMs: 500, timeoutMs: 120_000 },
  ]);
}

assert(
  typeof txHash === 'string' && /^0x[\da-f]{64}$/iu.test(txHash),
  `first spend (3 units) → tx hash: ${String(txHash).slice(0, 20)}...`,
);

// Second spend: 3 + 3 = 6 > 5 → should be rejected LOCALLY by the
// delegation twin without making any network call.
console.log('  Calling transferFungible(3) again — should fail locally...');
const secondError = await awayClient.callVatExpectError(
  awayKref,
  'transferFungible',
  [FAKE_TOKEN, BURN_ADDRESS, '3'],
);

assert(
  typeof secondError === 'string' &&
    secondError.includes('Insufficient budget'),
  `second spend (3 units) rejected locally: ${String(secondError).slice(0, 80)}`,
);

// ── Results ────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed === 0) {
  console.log('All delegation twin tests passed');
}
process.exit(failed > 0 ? 1 : 0);
