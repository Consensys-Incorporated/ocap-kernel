import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the local `ocap` JS plugin. oxlint rejects relative
 * `jsPlugins` specifiers in configs passed via `extends`.
 */
export const ocapPlugin = fileURLToPath(
  new URL('./ocap-plugin.ts', import.meta.url),
);
