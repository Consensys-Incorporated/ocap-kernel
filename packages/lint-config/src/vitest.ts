import { defineConfig } from 'oxlint';

export const vitestFiles = ['**/test/**/*', '**/*.test.ts', '**/*.test.tsx'];

/**
 * Port of `@metamask/eslint-config-vitest` and the `@vitest/eslint-plugin`
 * recommended preset it extends. Applies to {@link vitestFiles}.
 */
export default defineConfig({
  plugins: ['vitest'],
  overrides: [
    {
      files: vitestFiles,
      rules: {
        // vitest/recommended
        // @vitest/eslint-plugin's default. oxlint's default omits `assert`.
        'vitest/expect-expect': [
          'error',
          { assertFunctionNames: ['expect', 'assert'] },
        ],
        'vitest/no-identical-title': 'error',
        'vitest/no-import-node-test': 'error',
        'vitest/no-unneeded-async-expect-function': 'error',
        'vitest/prefer-called-exactly-once-with': 'error',
        'vitest/require-local-test-context-for-concurrent-snapshots': 'error',
        'vitest/valid-describe-callback': 'error',
        'vitest/valid-expect-in-promise': 'error',
        'vitest/valid-title': 'error',
        // @metamask/eslint-config-vitest
        'vitest/consistent-test-it': ['error', { fn: 'it' }],
        'vitest/no-alias-methods': 'error',
        'vitest/no-commented-out-tests': 'error',
        'vitest/no-conditional-expect': 'error',
        'vitest/no-conditional-in-test': 'error',
        'vitest/no-disabled-tests': 'error',
        'vitest/no-duplicate-hooks': 'error',
        'vitest/no-focused-tests': 'error',
        'vitest/no-interpolation-in-snapshots': 'error',
        'vitest/no-mocks-import': 'error',
        'vitest/no-restricted-matchers': [
          'error',
          {
            resolves: 'Use `expect(await promise)` instead.',
            toBeFalsy: 'Avoid `toBeFalsy`.',
            toBeTruthy: 'Avoid `toBeTruthy`.',
            toMatchSnapshot: 'Use `toMatchInlineSnapshot()` instead.',
            toThrowErrorMatchingSnapshot:
              'Use `toThrowErrorMatchingInlineSnapshot()` instead.',
          },
        ],
        'vitest/no-standalone-expect': 'error',
        'vitest/no-test-prefixes': 'error',
        'vitest/no-test-return-statement': 'error',
        'vitest/prefer-hooks-on-top': 'error',
        'vitest/prefer-lowercase-title': ['error', { ignore: ['describe'] }],
        'vitest/prefer-spy-on': 'error',
        'vitest/prefer-strict-equal': 'error',
        'vitest/prefer-to-be': 'error',
        'vitest/prefer-to-contain': 'error',
        'vitest/prefer-to-have-length': 'error',
        'vitest/prefer-todo': 'error',
        'vitest/require-to-throw-message': 'error',
        'vitest/require-top-level-describe': 'error',
        'vitest/valid-expect': ['error', { alwaysAwait: true }],
      },
    },
  ],
});
