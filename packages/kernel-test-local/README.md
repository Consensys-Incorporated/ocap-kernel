# `@ocap/kernel-test-local`

Local-only E2E tests that use a locally hosted language model.

## Overview

This package contains E2E tests that require a running Ollama instance with specific models installed. These tests are **not run in CI** and are intended for local development and validation only. Because language model outputs are inherently non-deterministic, these tests may occasionally fail even when the implementation is correct.

The agent tests launch a hardened kernel and run the agent inside a vat (the agent vat of `@ocap/kernel-test`), with the language model and the REPL's parser offered as kernel services. They assert on what the vat logs. The same vat runs against scripted model responses in `@ocap/kernel-test`, which does run in CI.

## Setup

[SETUP.md](./test/SETUP.md)

## Running Tests

From the repository root:

```bash
yarn test:e2e:local
```

From this package directory:

```bash
yarn test:e2e:local
```

## Troubleshooting

[TROUBLESHOOTING.md](./test/TROUBLESHOOTING.md)

## Contributing

This package is part of the ocap-kernel monorepo. For contributing guidelines, see the [main repository README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
