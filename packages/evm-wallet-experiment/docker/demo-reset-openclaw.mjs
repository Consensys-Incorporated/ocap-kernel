/* oxlint-disable node/no-sync, node/no-process-env */
import { spawnSync } from 'node:child_process';

import {
  awayServiceForDemoPair,
  demoDockerComposeArgs,
  DEMO_PACKAGE_ROOT,
} from './demo-compose-lib.mjs';

const argv = process.argv.slice(2);
const { pair, dockerArgs } = demoDockerComposeArgs(argv);

if (pair !== 'bundler-7702') {
  console.log(
    'OpenClaw state is only used with pair bundler-7702; nothing to reset for this pair.',
  );
  process.exit(0);
}

const away = awayServiceForDemoPair(pair);
const openclawDir = `/run/ocap/${away}/.openclaw`;

const spawned = spawnSync(
  'docker',
  [...dockerArgs, 'exec', away, 'rm', '-rf', openclawDir],
  { cwd: DEMO_PACKAGE_ROOT, stdio: 'inherit', env: process.env },
);
if (spawned.status !== 0) {
  process.exit(spawned.status ?? 1);
}

console.log(
  `OpenClaw state removed at ${openclawDir} on ocap-run volume. Run: yarn docker:demo:setup`,
);
