/* oxlint-disable node/no-process-env, node/no-sync */
/**
 * Host-side script to set up wallet subclusters on running Docker containers.
 *
 * Usage:
 *   yarn tsx test/e2e/docker/setup-wallets.ts [delegation-mode]
 *
 * Delegation modes: bundler-7702 (default), bundler-hybrid, peer-relay
 *
 * After setup, writes `/run/ocap/docker-delegation-{home,away}.json` on the shared
 * volume (via `docker compose cp`) so `yarn docker:delegate` can run inside a kernel
 * container with matching coordinator krefs and socket path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerKernelServicesForMode } from './helpers/docker-e2e-kernel-services.ts';
import type { DockerE2eKernelMode } from './helpers/docker-e2e-kernel-services.ts';
import {
  callVat,
  dockerComposeCp,
  getServiceInfo,
  readContracts,
} from './helpers/docker-exec.ts';
import type { ContractAddresses } from './helpers/docker-exec.ts';
import {
  resolveOnChainDelegateAddress,
  setup7702Away,
  setupHome,
  setupHybridAway,
  setupPeerRelayAway,
} from './helpers/scenarios.ts';
import type {
  AwayResult,
  DockerKernelServicePair,
  HomeResult,
} from './helpers/scenarios.ts';

const mode = process.argv[2] ?? process.env.DELEGATION_MODE ?? 'bundler-7702';

type SetupAwayFn = (
  services: DockerKernelServicePair,
  contracts: ContractAddresses,
  home: HomeResult,
) => AwayResult | Promise<AwayResult>;

const awaySetupFns: Record<string, SetupAwayFn> = {
  'bundler-7702': setup7702Away,
  'bundler-hybrid': setupHybridAway,
  'peer-relay': setupPeerRelayAway,
};

function writeDockerDelegationContextFiles(
  homeService: string,
  home: HomeResult,
  away: AwayResult,
): void {
  const { socketPath } = getServiceInfo(homeService);
  const homeCtx = {
    socketPath,
    kref: home.kref,
    coordinatorKref: home.kref,
    smartAccountAddress: home.smartAccountAddress,
    address: home.address,
    ocapUrl: home.ocapUrl,
  };
  const awayCtx = {
    delegateAddress: away.delegateAddress,
    ...(away.smartAccountAddress === undefined
      ? {}
      : { smartAccountAddress: away.smartAccountAddress }),
  };
  const dir = mkdtempSync(join(tmpdir(), 'ocap-docker-delegation-'));
  try {
    const homeFile = join(dir, 'docker-delegation-home.json');
    const awayFile = join(dir, 'docker-delegation-away.json');
    writeFileSync(homeFile, `${JSON.stringify(homeCtx, null, 2)}\n`);
    writeFileSync(awayFile, `${JSON.stringify(awayCtx, null, 2)}\n`);
    dockerComposeCp(
      homeFile,
      homeService,
      '/run/ocap/docker-delegation-home.json',
    );
    dockerComposeCp(
      awayFile,
      homeService,
      '/run/ocap/docker-delegation-away.json',
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
  console.log(
    'Wrote /run/ocap/docker-delegation-{home,away}.json for yarn docker:delegate.',
  );
}

async function main() {
  const setupAway = awaySetupFns[mode];
  if (!setupAway) {
    console.error(`Unknown delegation mode: ${mode}`);
    console.error('Valid modes: bundler-7702, bundler-hybrid, peer-relay');
    process.exit(1);
  }

  console.log(`Setting up wallets (mode: ${mode})...`);

  const kernelServices = dockerKernelServicesForMode(mode);
  const contracts = readContracts();
  console.log(`Contracts: EntryPoint=${contracts.EntryPoint.slice(0, 10)}...`);

  const home = setupHome(kernelServices, contracts, {
    delegationMode: mode as DockerE2eKernelMode,
  });
  console.log(
    `Home (${kernelServices.home}): kref=${home.kref} SA=${home.smartAccountAddress.slice(0, 10)}...`,
  );

  const away = await setupAway(kernelServices, contracts, home);
  console.log(
    `Away (${kernelServices.away}): kref=${away.kref} delegate=${away.delegateAddress.slice(0, 10)}...`,
  );
  if (away.smartAccountAddress) {
    console.log(`Away SA: ${away.smartAccountAddress}`);
  }

  const delegate = resolveOnChainDelegateAddress({
    delegationMode: mode,
    home,
    away,
  });
  console.log(
    mode === 'peer-relay'
      ? `Creating delegation: on-chain delegate = home (${delegate.slice(0, 10)}...) for peer-relay redeem`
      : `Creating delegation: home → away delegate ${delegate.slice(0, 10)}...`,
  );

  // Build a transfer-native grant with 1000 ETH max spend.
  // maxAmount is passed as a string because JSON cannot carry BigInt;
  // buildTransferNativeGrant coerces it back to BigInt.
  const maxSpendWei = (1000n * 10n ** 18n).toString();
  console.log('Building transfer-native grant: maxAmount = 1000 ETH');

  const signedGrant = callVat(
    kernelServices.home,
    home.kref,
    'buildTransferNativeGrant',
    [{ delegate, maxAmount: maxSpendWei, chainId: 31337 }],
  );
  console.log(
    `Grant signed: ${(signedGrant as { delegation: { id: string } }).delegation.id.slice(0, 20)}...`,
  );

  callVat(kernelServices.away, away.kref, 'receiveDelegation', [signedGrant]);
  console.log('Grant received by away wallet; delegation twin active.');

  writeDockerDelegationContextFiles(kernelServices.home, home, away);

  console.log('Wallet setup complete.');
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
