/* oxlint-disable node/no-sync, node/no-process-env */
import { spawnSync } from 'node:child_process';

import {
  awayServiceForDemoPair,
  homeServiceForDemoPair,
  demoDockerComposeArgs,
  DEMO_PACKAGE_ROOT,
} from './demo-compose-lib.mjs';

const [side, ...rest] = process.argv.slice(2);

if (side !== 'away' && side !== 'home') {
  console.error(`Usage: attach.mjs <away|home> [--pair <pair>]`);
  process.exit(1);
}

const { pair, dockerArgs } = demoDockerComposeArgs(rest);
const service =
  side === 'away' ? awayServiceForDemoPair(pair) : homeServiceForDemoPair(pair);

const spawned = spawnSync(
  'docker',
  [...dockerArgs, 'exec', '-it', service, 'bash'],
  {
    cwd: DEMO_PACKAGE_ROOT,
    stdio: 'inherit',
    env: process.env,
  },
);
process.exit(spawned.status ?? 1);
