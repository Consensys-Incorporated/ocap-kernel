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
};

export default config;
