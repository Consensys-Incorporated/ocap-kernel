/* oxlint-disable */
/**
 * Create a delegation on the home kernel and push it to the away node over CapTP.
 *
 * Connects to the home daemon socket only — the delegation flows to the
 * away node through the existing peer (OCAP) connection, exercising the real
 * cross-kernel path.
 *
 * Usage:
 *   node --conditions development /app/packages/evm-wallet-experiment/docker/create-delegation.mjs
 *
 * Options (env vars):
 *   CAVEAT_ETH_LIMIT  — total native-token transfer limit in ETH (default: unlimited)
 *
 * Expects `/run/ocap/docker-delegation-{home,away}.json` on the shared volume
 * (written by `yarn docker:setup:wallets`). Kernel `*-ready.json` files only
 * expose `socketPath`, not coordinator krefs or wallet addresses.
 */

import '@metamask/kernel-shims/endoify-node';

import { existsSync, readFileSync } from 'node:fs';

import { makeDaemonClient } from '../test/e2e/docker/helpers/daemon-client.mjs';
import {
  buildCaveatsFromEnv,
  createDelegationForDockerStack,
  pushDelegationOverPeer,
  resolveOnChainDelegateForDockerMode,
} from '../test/e2e/docker/helpers/delegation-transfer.mjs';

const HOME_CTX = '/run/ocap/docker-delegation-home.json';
const AWAY_CTX = '/run/ocap/docker-delegation-away.json';

async function main() {
  if (!existsSync(HOME_CTX) || !existsSync(AWAY_CTX)) {
    console.error(
      '[delegation] Missing docker-delegation context files. Run on the host first:',
    );
    console.error('  yarn docker:setup:wallets');
    process.exit(1);
  }
  const homeInfo = JSON.parse(readFileSync(HOME_CTX, 'utf8'));
  const awayInfo = JSON.parse(readFileSync(AWAY_CTX, 'utf8'));
  const delegationMode = process.env.DELEGATION_MODE ?? 'bundler-7702';

  const coordinatorKref = homeInfo.coordinatorKref ?? homeInfo.kref;
  if (typeof coordinatorKref !== 'string' || !coordinatorKref) {
    throw new Error(
      `${HOME_CTX} must include coordinatorKref or kref (run docker:setup:wallets).`,
    );
  }
  const socketPath = homeInfo.socketPath;
  if (typeof socketPath !== 'string' || !socketPath) {
    throw new Error(
      `${HOME_CTX} must include socketPath (run docker:setup:wallets).`,
    );
  }

  const home = makeDaemonClient(socketPath);

  const callHome = (method, args) =>
    home.callVat(coordinatorKref, method, args);

  const delegate = resolveOnChainDelegateForDockerMode({
    delegationMode,
    homeInfo,
    awayInfo,
  });
  console.log(`[delegation] home coordinator: ${coordinatorKref}`);
  console.log(`[delegation] mode: ${delegationMode}`);
  console.log(
    `[delegation] on-chain delegate: ${delegate}${
      delegationMode === 'peer-relay'
        ? ' (home; peer-relay redeem)'
        : awayInfo.smartAccountAddress
          ? ' (away smart account)'
          : ' (away EOA)'
    }`,
  );

  const caveats = buildCaveatsFromEnv();
  const ethLimit = process.env.CAVEAT_ETH_LIMIT;
  if (ethLimit) {
    console.log(
      `[delegation] caveat: nativeTokenTransferAmount <= ${ethLimit} ETH`,
    );
  }

  console.log('[delegation] creating on home...');
  const delegation = await createDelegationForDockerStack({
    callHome,
    awayInfo,
    homeInfo,
    delegationMode,
    caveats,
  });
  console.log(`[delegation] id: ${delegation.id}`);
  console.log(`[delegation] status: ${delegation.status}`);

  console.log('[delegation] pushing to away over CapTP...');
  await pushDelegationOverPeer(callHome, delegation);
  console.log(
    '[delegation] done — away received the delegation over the peer connection.',
  );
}

main().catch((err) => {
  console.error('[delegation] FATAL:', err);
  process.exit(1);
});
