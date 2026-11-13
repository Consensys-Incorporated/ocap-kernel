import {
  base,
  baseEnv,
  nodejs,
  nodejsEnv,
  typescript,
  typescriptFiles,
  vitest,
  vitestFiles,
} from '@ocap/lint-config';
import { defineConfig } from 'oxlint';

// Overrides from the extended layers always apply after top-level `rules`, so
// rules here that must beat a layer's override are themselves overrides.
export default defineConfig({
  extends: [base, nodejs, typescript, vitest],

  options: {
    typeAware: true,
    // Stale directives fail lint so they leave with the code they covered.
    reportUnusedDisableDirectives: 'error',
  },

  plugins: ['react'],

  env: { ...baseEnv, ...nodejsEnv },

  ignorePatterns: [
    '**/.claude',
    '**/coverage',
    '**/dist',
    '**/docs',
    '**/node_modules',
  ],

  overrides: [
    {
      // ESLint parsed these as scripts, where this rule does nothing.
      files: ['**/*.cjs'],
      rules: {
        'import/unambiguous': 'off',
      },
    },

    {
      files: typescriptFiles,
      rules: {
        // Don't require JSDoc for type declarations.
        'ocap/require-jsdoc': [
          'error',
          {
            require: {
              FunctionDeclaration: true,
              MethodDefinition: true,
              ClassDeclaration: true,
            },
            contexts: [],
          },
        ],

        'typescript/explicit-function-return-type': [
          'error',
          {
            // To permit omitting the return type in situations like:
            // `const obj = { foo: (bar: string) => bar };`
            // We'll presume that `obj` has a type that enforces the return type.
            allowExpressions: true,
          },
        ],
        'typescript/no-explicit-any': 'error',

        // Replace this rule with the "verbatimModuleSyntax" tsconfig option
        // and "import/consistent-type-specifier-style".
        'typescript/consistent-type-imports': 'off',

        // This should only be enabled for JavaScript files.
        // Ref: https://github.com/import-js/eslint-plugin-import/issues/2215#issuecomment-911245486
        'import/unambiguous': 'off',

        'eslint/no-unused-expressions': [
          'error',
          {
            allowShortCircuit: true,
            allowTaggedTemplates: true,
            allowTernary: true,
          },
        ],

        'eslint/no-console': 'error',

        // tsgolint also flags assertions that are only contextually
        // unnecessary, which typescript-eslint accepts.
        'typescript/no-unnecessary-type-assertion': 'off',

        // typedoc reads `@module` from file headers. eslint-plugin-jsdoc's
        // `typed` check skipped comments not attached to a node; oxlint's
        // does not, so allow the tag outright.
        'jsdoc/check-tag-names': [
          'error',
          { typed: true, definedTags: ['module'] },
        ],
      },
    },

    {
      files: [
        '**/*.test.*',
        '**/build/**/*',
        '**/scripts/**/*',
        '**/test/**/*',
      ],
      rules: {
        'eslint/no-console': 'off',
      },
    },

    {
      files: ['**/*.tsx', '**/ui/**/*.ts'],
      rules: {
        // `eslint-plugin-react` jsx-runtime preset.
        'react/react-in-jsx-scope': 'off',
        'react/rules-of-hooks': 'error',
        'react/exhaustive-deps': 'warn',
      },
    },

    {
      files: vitestFiles,
      rules: {
        // It's fine to do this in tests.
        'typescript/no-non-null-assertion': 'off',
        // This causes false positives in tests especially.
        'typescript/unbound-method': 'off',
        // ESLint's rule flagged only an `if` placed directly in a test body.
        // oxlint's port flags every conditional at any depth, including inside
        // mock implementations, and has no options to narrow it.
        'vitest/no-conditional-in-test': 'off',
        // TODO: Remove these once the vitest layer matches the latest
        // `@metamask/eslint-config-vitest`.
        'vitest/no-alias-methods': 'off',
        'vitest/prefer-called-exactly-once-with': 'off',

        'typescript/explicit-function-return-type': 'off',
        'ocap/require-jsdoc': 'off',
      },
    },

    {
      files: ['**/*.types.test.ts'],
      rules: {
        'typescript/no-explicit-any': 'off',
        'eslint/no-unused-expressions': 'off',
        'vitest/expect-expect': 'off',
        'vitest/no-conditional-in-test': 'off',
      },
    },

    {
      files: ['**/scripts/**/*'],
      rules: {
        // Script files have reasonable cause to read from process.env
        'node/no-process-env': 'off',
      },
    },

    {
      files: ['**/*'],
      rules: {
        // We use the actual source file extensions and let tsc rewrite them.
        'import/extensions': ['error', 'ignorePackages'],

        // We have been hoisted by our own petard in the past.
        'import/no-cycle': ['error', { ignoreExternal: true, maxDepth: 3 }],

        // We use unassigned imports for e.g. `import '@metamask/kernel-shims/endoify'`.
        'import/no-unassigned-import': 'off',

        // Equivalent to the MetaMask config except that we allow the "in"
        // operator.
        'ocap/no-restricted-syntax': [
          'error',
          {
            selector: 'WithStatement',
            message: 'With statements are not allowed',
          },
          {
            selector: 'SequenceExpression',
            message: 'Sequence expressions are not allowed',
          },
          {
            selector:
              "PropertyDefinition[accessibility='private'], MethodDefinition[accessibility='private'], TSParameterProperty[accessibility='private']",
            message: 'Use a hash name instead.',
          },
        ],

        // e.g. (0 < x && x < 47) is OK.
        'eslint/yoda': ['error', 'never', { exceptRange: true }],
      },
    },

    {
      files: ['packages/kernel-shims/**/*'],
      globals: {
        hardenIntrinsics: 'readonly',
        lockdown: 'readonly',
        repairIntrinsics: 'readonly',
      },
    },

    {
      files: [
        '**/vite.config.ts',
        '**/vitest.config.ts',
        'packages/extension/**/*',
        'packages/kernel-cli/**/*',
        'packages/kernel-node-runtime/**/*-worker.ts',
        'packages/kernel-node-runtime/test/workers/**/*',
        'packages/omnium-gatherum/**/*',
        'packages/repo-tools/**/*',
      ],
      rules: {
        'node/no-process-env': 'off',
      },
    },

    {
      files: [
        '**/vite.config.*',
        '**/vite-plugins/**/*',
        '**/vats/**/*.js',
        '**/vitest.config.ts',
        '**/vitest.config.e2e.ts',
        'yarn.config.cjs',
      ],
      rules: {
        'ocap/require-jsdoc': 'off',
      },
    },
  ],
});
