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

`kref-scaling.perf.test.ts` times message delivery against a growing number
of live krefs, spread over several holder/minter vat pairs.
`concurrent-load.perf.test.ts` holds a fixed number of live krefs and sends
from many clients at once, each sending its next message when its last is
answered, recording throughput and latency. To run one profile, name it:
`yarn workspace @ocap/kernel-test test:perf concurrent-load`.

Both read their settings from
[`src/performance/.env.perf`](./src/performance/.env.perf), which describes
each one. An environment variable of the same name overrides it for a run,
for example `KREF_PERF_MAX_EXPONENT=4 yarn workspace @ocap/kernel-test
test:perf kref-scaling`. A missing or malformed setting, or a `KREF_PERF_*` or
`LOAD_PERF_*` variable that is not one, fails the run before it starts.

Past about 3e6 krefs a vat holding them exhausts V8's default 4 GB heap. Vat
state lives in an in-memory map in the vat's worker, so virtual objects do not
avoid this.

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
