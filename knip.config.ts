import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Only lint dependencies, i.e. what `knip --dependencies` checks.
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
    '@arethetypeswrong/cli',
    '@lavamoat/allow-scripts',
    '@lavamoat/preinstall-always-fail',
    '@metamask/create-release-branch',
    '@types/setimmediate',
    'setimmediate',
    'turbo',

    // Used by @metamask/kernel-node-runtime to build the sqlite3 bindings
    'node-gyp',

    // These are peer dependencies of various modules we actually do
    // depend on, which have been elevated to full dependencies (even
    // though we don't actually depend on them) in order to work around a
    // bug in the bundler wherein it gets confused by absent peer
    // dependencies.  These should be removed (both from here and from
    // the declared dependencies in package.json) once KK fixes the
    // bundler, which should be RSN.
    '@types/webextension-polyfill',
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
