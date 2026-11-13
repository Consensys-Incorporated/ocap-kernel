import { defineConfig } from 'oxlint';

export const typescriptFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

/**
 * Port of `@metamask/eslint-config-typescript` and the presets it extends:
 * `typescript-eslint` recommended and recommended-type-checked,
 * `eslint-plugin-import-x` typescript, and `eslint-plugin-jsdoc`
 * recommended-typescript-error. Applies to {@link typescriptFiles}.
 *
 * Only rules that differ from the base layer are listed. Type-aware rules run
 * only when `options.typeAware` is set in the root config.
 */
export default defineConfig({
  plugins: ['import', 'jsdoc', 'promise', 'typescript'],
  overrides: [
    {
      files: typescriptFiles,
      rules: {
        // typescript-eslint/eslint-recommended
        'eslint/constructor-super': 'off',
        'eslint/getter-return': 'off',
        'eslint/no-class-assign': 'off',
        'eslint/no-const-assign': 'off',
        'eslint/no-dupe-keys': 'off',
        'eslint/no-func-assign': 'off',
        'eslint/no-import-assign': 'off',
        'eslint/no-new-native-nonconstructor': 'off',
        'eslint/no-obj-calls': 'off',
        'eslint/no-redeclare': 'off',
        'eslint/no-setter-return': 'off',
        'eslint/no-this-before-super': 'off',
        'eslint/no-undef': 'off',
        'eslint/no-unreachable': 'off',
        'eslint/no-unsafe-negation': 'off',
        'eslint/no-with': 'off',
        // eslint-plugin-import-x typescript
        'import/named': 'off',
        // typescript-eslint/recommended-type-checked
        'eslint/no-implied-eval': 'off',
        'eslint/no-throw-literal': 'off',
        'eslint/prefer-promise-reject-errors': 'off',
        'typescript/await-thenable': 'error',
        'typescript/ban-ts-comment': 'error',
        'typescript/no-array-delete': 'error',
        'typescript/no-base-to-string': 'error',
        'typescript/no-duplicate-enum-values': 'error',
        'typescript/no-empty-object-type': 'error',
        'typescript/no-extra-non-null-assertion': 'error',
        'typescript/no-floating-promises': 'error',
        'typescript/no-for-in-array': 'error',
        'typescript/no-implied-eval': 'error',
        'typescript/no-misused-new': 'error',
        'typescript/no-misused-promises': 'error',
        'typescript/no-non-null-asserted-optional-chain': 'error',
        'typescript/no-require-imports': 'error',
        'typescript/no-this-alias': 'error',
        'typescript/no-unnecessary-type-assertion': 'error',
        'typescript/no-unnecessary-type-constraint': 'error',
        'typescript/no-unsafe-declaration-merging': 'error',
        'typescript/no-unsafe-function-type': 'error',
        'typescript/no-unsafe-unary-minus': 'error',
        'typescript/no-wrapper-object-types': 'error',
        'typescript/only-throw-error': 'error',
        'typescript/prefer-as-const': 'error',
        'typescript/prefer-namespace-keyword': 'error',
        'typescript/restrict-plus-operands': 'error',
        'typescript/triple-slash-reference': 'error',
        'typescript/unbound-method': 'error',
        // @metamask/eslint-config-typescript
        'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
        'import/no-duplicates': 'off',
        'jsdoc/require-param-type': 'off',
        'jsdoc/require-property-type': 'off',
        'jsdoc/require-returns-type': 'off',
        'promise/valid-params': 'off',
        'typescript/array-type': 'error',
        'typescript/consistent-type-assertions': 'error',
        'typescript/consistent-type-definitions': ['error', 'type'],
        'typescript/consistent-type-exports': 'error',
        'typescript/explicit-function-return-type': 'error',
        'typescript/no-meaningless-void-operator': 'error',
        'typescript/no-namespace': ['error', { allowDefinitionFiles: true }],
        'typescript/no-non-null-assertion': 'error',
        'typescript/no-unnecessary-boolean-literal-compare': 'error',
        'typescript/no-unnecessary-qualifier': 'error',
        'typescript/parameter-properties': 'error',
        'typescript/prefer-enum-initializers': 'error',
        'typescript/prefer-for-of': 'error',
        'typescript/prefer-function-type': 'error',
        'typescript/prefer-includes': 'error',
        'typescript/prefer-nullish-coalescing': 'error',
        // tsgolint's port reports four sites that typescript-eslint did not.
        'typescript/prefer-optional-chain': 'off',
        'typescript/prefer-promise-reject-errors': [
          'error',
          { allowThrowingUnknown: true },
        ],
        'typescript/prefer-readonly': 'error',
        'typescript/prefer-reduce-type-parameter': 'error',
        'typescript/prefer-string-starts-ends-with': 'error',
        'typescript/promise-function-async': 'error',
        'typescript/restrict-template-expressions': [
          'error',
          { allowBoolean: true, allowNumber: true },
        ],
        'typescript/switch-exhaustiveness-check': [
          'error',
          { considerDefaultExhaustiveForUnions: true },
        ],
        'typescript/unified-signatures': 'error',
        // jsdoc/flat/recommended-typescript-error
        'jsdoc/check-tag-names': ['error', { typed: true }],

        'ocap/no-restricted-syntax': [
          'error',
          {
            selector:
              "PropertyDefinition[accessibility='private'], MethodDefinition[accessibility='private'], TSParameterProperty[accessibility='private']",
            message: 'Use a hash name instead.',
          },
        ],
      },
    },
  ],
});
