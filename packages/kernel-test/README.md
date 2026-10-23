# `@ocap/kernel-test`

Run tests on the kernel that involve interaction with vats

## Performance profiles

`src/performance/` holds profiles, which `yarn test` skips. Run them after
`yarn build` with:

```sh
yarn workspace @ocap/kernel-test test:performance
```

Each profile prints a table and writes it, with the platform it ran on, to
`logs/performance/`. `kref-scaling.test.ts` times message delivery at 1e1 to
1e6 live krefs; `KREF_PERF_MAX_EXPONENT` lowers the ceiling and
`KREF_PERF_SAMPLES` sets the number of sends timed at each count.

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
