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
prints a table and writes its results, with the platform it ran on, as JSON to
a directory for the run under `logs/performance/runs/`. When the run ends,
those are charted as SVG and collected with tables into the run's `REPORT.md`,
even if a profile failed. `yarn workspace @ocap/kernel-test perf:report [run
directory]` renders a run again, by default the latest. In the weekly
`performance` workflow, the first trial shows its report's tables in the run
summary, and each trial uploads its whole report, charts included, as a
`report-N` artifact.

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

`gc-under-load.perf.test.ts` runs rounds of one workload at a time (`ping`,
`pingHeld`, `churn`, which mints and drops tokens, and `fetch`, which hands
one to the kernel), reaps every vat after each round, and fails if the store
holds more objects, promises, c-list or vatstore rows than before the load.
`GC_PERF_KREFS`, `GC_PERF_PAIRS`, `GC_PERF_ROUNDS`, `GC_PERF_MESSAGES` and
`GC_PERF_CONCURRENCY` override its defaults.

Past about 3e6 krefs a vat holding them exhausts V8's default 4 GB heap. Vat
state lives in an in-memory map in the vat's worker, so virtual objects do not
avoid this.

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
