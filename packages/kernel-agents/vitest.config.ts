import { mergeConfig } from '@ocap/repo-tools/vitest-config';
import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';

import defaultConfig from '../../vitest.config.ts';

export default defineConfig((args) => {
  return mergeConfig(
    args,
    defaultConfig,
    defineProject({
      test: {
        name: 'kernel-agents',
        include: ['src/**/*.test.ts'],
        // Exclude E2E setup test from regular test runs
        exclude: ['test/e2e'],
        // Capability modules build discoverable exos at import, which needs a
        // `harden` global; install the endoify mock for every test in the
        // package so it is present before any capability module loads. `ses`
        // loads first so that the REPL's evaluator gets a real `Compartment`,
        // which the mock keeps while replacing `harden`.
        setupFiles: [
          fileURLToPath(import.meta.resolve('ses')),
          fileURLToPath(
            import.meta.resolve('@ocap/repo-tools/test-utils/mock-endoify'),
          ),
        ],
      },
    }),
  );
});
