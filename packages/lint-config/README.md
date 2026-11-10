# `@ocap/lint-config`

Shared oxlint configuration for the monorepo. The root `oxlint.config.ts` extends these layers:

- `base`: port of `@metamask/eslint-config`
- `nodejs`: port of `@metamask/eslint-config-nodejs`
- `typescript`: port of `@metamask/eslint-config-typescript`, scoped to `typescriptFiles`
- `vitest`: port of `@metamask/eslint-config-vitest`, scoped to `vitestFiles`

oxlint does not inherit `env` from extended configs, so the root config sets it from `baseEnv` and `nodejsEnv`.

Two rules without a native oxlint port, `ocap/no-restricted-syntax` and `ocap/require-jsdoc`, come from the local JS plugin in `src/plugins/ocap-plugin.ts`. They port ESLint core's `no-restricted-syntax` and `eslint-plugin-jsdoc`'s `require-jsdoc`.

The package is consumed from source and has no build step.

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
