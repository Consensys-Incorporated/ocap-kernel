# `@ocap/kernel-test`

Run tests on the kernel that involve interaction with vats

## Performance profiles

`src/performance/` holds profiles, which `yarn test` skips. They run weekly
in the `performance` workflow with the repository's other `*.perf.test.ts`
files. Run them locally after `yarn build` with:

```sh
yarn workspace @ocap/kernel-test test:perf
```

The full suite takes about 15 minutes and 10 GB of memory. Each profile
writes its results table, with the platform it ran on, to `logs/performance/`
after every step, and prints it at the end. In the weekly `performance` workflow, the first
trial shows those tables in the run summary, and each trial uploads the
directory as a `report-N` artifact.

`kref-scaling.perf.test.ts` times message delivery at 1e1 to
1e6 live krefs, spread over 1, 4, 16 and 64 holder/minter vat pairs.
`KREF_PERF_MAX_EXPONENT` sets the ceiling, `KREF_PERF_PAIRS` the pair counts
(comma-separated), and `KREF_PERF_SAMPLES` the number of sends timed at each
count.

`concurrent-load.perf.test.ts` holds 1e5 live krefs over 1, 8 and 64 pairs and
sends from 1 to 256 clients at once, each sending its next message when its
last is answered, recording throughput and latency. `LOAD_PERF_KREFS`,
`LOAD_PERF_PAIRS`, `LOAD_PERF_CONCURRENCY` (comma-separated) and
`LOAD_PERF_MESSAGES` (per cell) override these. To run one profile, name it:
`yarn workspace @ocap/kernel-test test:perf concurrent-load`.

Past about 3e6 krefs a vat holding them exhausts V8's default 4 GB heap. Vat
state lives in an in-memory map in the vat's worker, so virtual objects do not
avoid this.

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
