/* oxlint-disable node/no-sync, node/no-process-env */
import { spawnSync } from 'node:child_process';

import {
  homeServiceForDemoPair,
  demoDockerComposeArgs,
  DEMO_PACKAGE_ROOT,
} from './demo-compose-lib.mjs';

const SCRIPT_ON_HOST = 'docker/create-delegation.mjs';
const SCRIPT_IN_CONTAINER =
  '/app/packages/evm-wallet-experiment/docker/create-delegation.mjs';

const argv = process.argv.slice(2);
const { pair, dockerArgs } = demoDockerComposeArgs(argv);
const home = homeServiceForDemoPair(pair);

const cp = spawnSync(
  'docker',
  [...dockerArgs, 'cp', SCRIPT_ON_HOST, `${home}:${SCRIPT_IN_CONTAINER}`],
  { cwd: DEMO_PACKAGE_ROOT, stdio: 'inherit', env: process.env },
);
if (cp.status !== 0) {
  process.exit(cp.status ?? 1);
}

const envArgs = ['--env', `DELEGATION_MODE=${pair}`];
if (process.env.CAVEAT_ETH_LIMIT) {
  envArgs.push('--env', `CAVEAT_ETH_LIMIT=${process.env.CAVEAT_ETH_LIMIT}`);
}

const exec = spawnSync(
  'docker',
  [
    ...dockerArgs,
    'exec',
    ...envArgs,
    home,
    'node',
    '--conditions',
    'development',
    SCRIPT_IN_CONTAINER,
  ],
  { cwd: DEMO_PACKAGE_ROOT, stdio: 'inherit', env: process.env },
);
process.exit(exec.status ?? 1);
