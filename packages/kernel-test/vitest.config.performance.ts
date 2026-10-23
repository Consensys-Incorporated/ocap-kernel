import { mergeConfig } from '@ocap/repo-tools/vitest-config';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';

import defaultConfig from '../../vitest.config.ts';

export default defineConfig((args) => {
  const config = mergeConfig(
    args,
    defaultConfig,
    defineProject({
      test: {
        name: 'kernel-test:performance',
        setupFiles: [
          fileURLToPath(
            import.meta.resolve('@metamask/kernel-shims/endoify-node'),
          ),
        ],
        include: ['./src/performance/**/*.test.ts'],
        // One profile at a time, so they do not compete for the CPU.
        fileParallelism: false,
      },
    }),
  );
  // Instrumentation would skew the timings.
  delete config.test.coverage;
  // Profiles print their results, but the kernel's own console output would
  // bury them.
  config.test.silent = false;
  config.test.onConsoleLog = (log: string) =>
    log.startsWith('[performance]') ? undefined : false;
  return config;
});
