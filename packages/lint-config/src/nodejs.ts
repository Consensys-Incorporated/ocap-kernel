import { defineConfig } from 'oxlint';

/**
 * Globals for the Node.js layer.
 */
export const nodejsEnv = { es2022: true, node: true };

/**
 * Port of `@metamask/eslint-config-nodejs` and the `eslint-plugin-n`
 * recommended preset it extends. Most `n/*` rules have no oxlint port.
 */
export default defineConfig({
  plugins: ['import', 'node'],
  rules: {
    // eslint-plugin-n flat/recommended
    'node/no-exports-assign': 'error',
    // @metamask/eslint-config-nodejs
    'import/no-nodejs-modules': 'off',
    'node/callback-return': 'error',
    'node/exports-style': 'error',
    'node/global-require': 'error',
    'node/handle-callback-err': ['error', '^(err|error)$'],
    'node/no-mixed-requires': 'error',
    'node/no-new-require': 'error',
    'node/no-path-concat': 'error',
    'node/no-process-env': 'error',
    'node/no-sync': 'error',
  },
});
