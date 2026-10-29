import { mergeConfig } from '@ocap/repo-tools/vitest-config';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';

import defaultConfig from '../../vitest.config.ts';

// Timing tests, run on a schedule by .github/workflows/performance.yml
// rather than in the default suite.
export default defineConfig((args) => {
  const config = mergeConfig(
    args,
    defaultConfig,
    defineProject({
      test: {
        name: 'kernel-test:perf',
        setupFiles: [
          fileURLToPath(
            import.meta.resolve('@metamask/kernel-shims/endoify-node'),
          ),
        ],
        include: ['./src/**/*.perf.test.ts'],
        testTimeout: 30_000,
      },
    }),
  );
  config.test.coverage.enabled = false;
  return config;
});
