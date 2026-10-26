/* oxlint-disable node/no-sync */
/**
 * Loads `docker-e2e-stack-constants.json` and exports `dockerConfig`.
 * Edit the JSON file to change stack defaults; keep this module as the single import path.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const jsonPath = join(dir, 'docker-e2e-stack-constants.json');

/**
 * @typedef {object} DockerStackConfig
 * @property {number} anvilChainId - Chain ID for the local Anvil stack in Docker E2E.
 * @property {string} openclawPluginPathContainer - Wallet plugin path inside the kernel container.
 */

/** @type {DockerStackConfig} */
export const dockerConfig = JSON.parse(readFileSync(jsonPath, 'utf8'));
