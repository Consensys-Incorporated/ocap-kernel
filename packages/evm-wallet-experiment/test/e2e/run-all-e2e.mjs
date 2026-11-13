/* oxlint-disable node/no-process-env */
/**
 * Aggregate E2E runner for the evm-wallet package.
 *
 * Runs each Sepolia E2E script sequentially and reports aggregate results.
 * Skips all tests gracefully when required environment variables are missing.
 *
 * Required environment variables:
 *   PIMLICO_API_KEY  - Pimlico API key (free tier, Sepolia)
 *   SEPOLIA_RPC_URL  - Sepolia JSON-RPC endpoint
 *
 * Usage:
 *   PIMLICO_API_KEY=xxx SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/xxx \
 *     yarn workspace @ocap/evm-wallet-experiment test:e2e
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { PIMLICO_API_KEY, SEPOLIA_RPC_URL } = process.env;

if (!PIMLICO_API_KEY || !SEPOLIA_RPC_URL) {
  console.log(
    '\nSkipping all E2E tests: set PIMLICO_API_KEY and SEPOLIA_RPC_URL\n',
  );
  process.exit(0);
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));

const scripts = [
  'run-sepolia-e2e.mjs',
  'run-peer-e2e.mjs',
  'run-spending-limits-e2e.mjs',
];

let passedCount = 0;
let failedCount = 0;

for (const script of scripts) {
  const scriptPath = path.join(thisDir, script);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${script}`);
  console.log('='.repeat(60));

  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      ['--conditions', 'development', scriptPath],
      { env: process.env },
    );
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
    passedCount += 1;
  } catch (error) {
    if (error.stdout) {
      process.stdout.write(error.stdout);
    }
    if (error.stderr) {
      process.stderr.write(error.stderr);
    }
    failedCount += 1;
    console.error(`\nFAILED: ${script}\n`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(
  `E2E Summary: ${passedCount} passed, ${failedCount} failed (of ${scripts.length} scripts)`,
);
console.log('='.repeat(60));

process.exit(failedCount > 0 ? 1 : 0);
