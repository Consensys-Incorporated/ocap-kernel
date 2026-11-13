# Ocap Kernel Monorepo

Welcome to the Ocap Kernel team's monorepo! It is a work in progress.

## Usage

For detailed information on how to use the OCAP Kernel, please refer to:

- [Usage Guide](docs/usage.md) — Setting up, configuring, and running the kernel in browser and Node.js environments.
- [Kernel Guide](docs/kernel-guide.md) — Building on the kernel: writing vat code, kernel services, system subclusters, and persistence.

### Kernel Control Panel

You can launch a browser-based Kernel Control Panel to interact with and manage vats:

```bash
yarn workspace @ocap/extension run start
```

This will:

- Launch a development server serving the extension
- Set up a default cluster configuration
- Serve sample vat bundles
- Provide a UI for managing and interacting with the kernel and vats

The control panel allows you to:

- Launch vats
- View vat status
- Test kernel functionality
- Send messages to objects in vats
- **Inspect the database**: The control panel includes a built-in SQLite database inspector powered by SQLite WASM, allowing you to directly view and query the kernel's database through the browser interface. This is especially valuable since the kernel uses SQLite for persistence and would otherwise be difficult to inspect.

## Contributing

To get started:

- `yarn install`
- `yarn build`
  - This will build the entire monorepo in the correct order.
    You may need to re-run it if multiple packages have changed.
  - Note that some packages, e.g. `extension` `shims`, have special build processes.

Lint using `yarn lint` or `yarn lint:fix` from the root.

Note that the root package `test` script, as well as those of many packages, require
`yarn build` to be run first.

### Editor setup

The repository uses TypeScript 7, whose package ships a native compiler and language
server (`tsc --lsp`) in place of `tsserver`. VS Code's built-in TypeScript support cannot
load it and falls back to its bundled TypeScript version. To use the workspace version,
install the
[TypeScript (Native Preview)](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview)
extension.

### Writing tests

The kernel's code relies extensively on SES / lockdown. Many Agoric packages fail if
they are executed in a non-locked down environment. For this reason, tests should
generally be run under lockdown. This can, however, make it difficult to debug tests.
For this reason, our unit tests have a `development` mode, which can be used to
disable lockdown for debugging purposes. `development` mode always disables coverage
collection, but it does not disable lockdown in all packages. `development` mode
tests don't have to pass, and are not run in CI; they are for local debugging
purposes only.

### Adding new packages

See [`packages/create-package/README.md`](packages/create-package/README.md).

### Updating changelogs

See [`docs/contributing/updating-changelogs.md`](docs/contributing/updating-changelogs.md).

### Releasing

For information on creating releases, see the [MetaMask/core release documentation](https://github.com/MetaMask/core/blob/d6ce6e1c917b1a05356df365281a5db83f500210/docs/processes/releasing.md).

## References

- [Glossary](./docs/glossary.md)
- [Kernel Guide](./docs/kernel-guide.md)
