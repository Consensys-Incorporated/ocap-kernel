import { mergeConfig } from '@ocap/repo-tools/vitest-config';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig, defineProject } from 'vitest/config';

import defaultConfig from '../../vitest.config.ts';

export default defineConfig((args) => {
  const config = mergeConfig(
    args,
    defaultConfig,
    defineProject({
      test: {
        name: 'kernel-test',
        setupFiles: [
          fileURLToPath(
            import.meta.resolve('@metamask/kernel-shims/endoify-node'),
          ),
        ],
        testTimeout: 30_000,
        // Run on their own by `test:performance`.
        exclude: [...configDefaults.exclude, './src/performance/**'],
      },
    }),
  );

  if (args.mode !== 'development') {
    config.test.coverage.thresholds = true;
  }

  return config;
});
