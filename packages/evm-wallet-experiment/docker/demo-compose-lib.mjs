/* oxlint-disable node/no-sync, node/no-process-env, ocap/require-jsdoc */
/**
 * Shared parsing + `docker compose` argv for demo stack (one home/away pair).
 * Keep delegation-mode keys in sync with `test/e2e/docker/helpers/docker-e2e-kernel-services.ts`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dockerLibDir = dirname(fileURLToPath(import.meta.url));
export const DEMO_PACKAGE_ROOT = join(dockerLibDir, '..');

const COMPOSE_FILE = join(DEMO_PACKAGE_ROOT, 'docker/docker-compose.yml');
const ENV_FILE = join(DEMO_PACKAGE_ROOT, 'docker/.env.demo');

/** @type {Record<string, string>} */
export const DEMO_PAIR_TO_PROFILE = {
  'bundler-7702': '7702',
  'bundler-hybrid': '4337',
  'peer-relay': 'relay',
};

export const DEFAULT_DEMO_PAIR = 'bundler-7702';

export function awayServiceForDemoPair(pair) {
  if (pair === 'bundler-7702') {
    return 'kernel-away-bundler-7702';
  }
  if (pair === 'bundler-hybrid') {
    return 'kernel-away-bundler-hybrid';
  }
  if (pair === 'peer-relay') {
    return 'kernel-away-peer-relay';
  }
  throw new Error(`Unknown demo pair: ${pair}`);
}

export function homeServiceForDemoPair(pair) {
  if (pair === 'bundler-7702') {
    return 'kernel-home-bundler-7702';
  }
  if (pair === 'bundler-hybrid') {
    return 'kernel-home-bundler-hybrid';
  }
  if (pair === 'peer-relay') {
    return 'kernel-home-peer-relay';
  }
  throw new Error(`Unknown demo pair: ${pair}`);
}

export function parseDemoComposeArgv(argv) {
  let pair = process.env.OCAP_DEMO_PAIR ?? DEFAULT_DEMO_PAIR;
  const rest = [...argv];
  const i = rest.indexOf('--pair');
  if (i !== -1 && rest[i + 1]) {
    pair = rest[i + 1];
    rest.splice(i, 2);
  }
  const profile = DEMO_PAIR_TO_PROFILE[pair];
  if (!profile) {
    console.error(
      `Unknown pair "${pair}". Use: ${Object.keys(DEMO_PAIR_TO_PROFILE).join(', ')} (env OCAP_DEMO_PAIR, or --pair before compose subcommands).`,
    );
    process.exit(1);
  }
  return { pair, profile, rest };
}

export function demoDockerComposeArgs(argv) {
  const { pair, profile, rest } = parseDemoComposeArgv(argv);
  return {
    pair,
    profile,
    rest,
    dockerArgs: [
      'compose',
      '-f',
      COMPOSE_FILE,
      '--env-file',
      ENV_FILE,
      '--profile',
      profile,
      ...rest,
    ],
  };
}

export function runDemoCompose(argv) {
  const { pair, profile, dockerArgs } = demoDockerComposeArgs(argv);
  if (process.env.DEBUG_OCAP_DEMO_COMPOSE) {
    console.error(
      `[ocap demo compose] OCAP_DEMO_PAIR=${pair} profile=${profile}`,
    );
  }
  const spawned = spawnSync('docker', dockerArgs, {
    cwd: DEMO_PACKAGE_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (spawned.error) {
    throw spawned.error;
  }
  process.exit(spawned.status ?? 1);
}
