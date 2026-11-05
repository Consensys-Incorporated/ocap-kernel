import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  include: [
    'dependencies',
    'unlisted',
    'binaries',
    'unresolved',
    'catalog',
    'catalogReferences',
  ],
  // Build output is reached via `exports` and `bin` paths in package.json.
  ignore: ['**/dist/**'],
  ignoreDependencies: [
    // monorepo
    '@metamask/kernel-shims',
    '@metamask/kernel-cli',

    // Run by scripts/*.sh, which knip does not parse
    '@metamask/auto-changelog',
    'lint-staged',

    // we explicitly require cookie ^0.7.0 to eliminate a security vulnerability
    // https://github.com/advisories/GHSA-pxg6-pf52-xh8x
    'cookie',

    // miscellaneous
    '@agoric/internal',
    '@lavamoat/allow-scripts',
    '@lavamoat/preinstall-always-fail',
    '@metamask/create-release-branch',

    // Used by @metamask/kernel-node-runtime to build the sqlite3 bindings
    'node-gyp',
  ],
  workspaces: {
    '.': {},
    'packages/*': {
      // Vats, workers, and other files loaded by path are not reachable from
      // package entry points, so every source file counts as an entry.
      entry: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    },
    'packages/kernel-utils': {
      entry: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      // Optional peers of the `./vite-plugins` export
      ignoreDependencies: ['acorn', 'rolldown', 'vite'],
    },
    // OpenClaw plugins: nested packages outside the Yarn workspaces
    'packages/*/openclaw-plugin*': {
      entry: ['**/*.ts'],
    },
  },
};

export default config;
