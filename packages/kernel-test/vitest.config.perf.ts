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
        // Charts the run's profile reports when it is over.
        globalSetup: ['./src/performance/global-setup.ts'],
        // One file at a time, so they do not compete for the CPU.
        fileParallelism: false,
      },
    }),
  );
  config.test.coverage.enabled = false;
  // Profiles print their results, but the kernel's own console output would
  // bury them.
  config.test.silent = false;
  config.test.onConsoleLog = (log: string) =>
    log.startsWith('[performance]') ? undefined : false;
  return config;
});
