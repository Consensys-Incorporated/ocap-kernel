#!/usr/bin/env node
// Runs each probe at each snapshot and prints the matrix, so the comparison
// table on the page is measured rather than recalled.
//
//   node probe.mjs probes.json
//
// probes.json:
//   {
//     "snapshots": { "A": "9ff2ab72", "B": "origin/main", "C": "origin/feature-tip" },
//     "probes": [
//       { "name": "libp2p deps in ocap-kernel",
//         "cmd": "git show $REV:packages/ocap-kernel/package.json | grep -c '\"@libp2p/' || true" }
//     ]
//   }
//
// Each `cmd` runs under bash with REV set to the snapshot's revision and should
// print one short value. A snapshot with no revision (a proposal) gets "—".
// Prefer `git show $REV:path`, `git grep ... $REV -- path` and
// `git ls-tree -r --name-only $REV path`; never check revisions out. `git grep`
// prefixes each path with "$REV:", so strip it (sed "s#^$REV:##") before
// cutting paths apart: refs like origin/main contain slashes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { snapshots, probes } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const names = Object.keys(snapshots);

const run = (cmd, rev) => {
  try {
    return execFileSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      env: { ...process.env, REV: rev },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `ERR: ${String(error.stderr || error.message).split('\n')[0]}`;
  }
};

const rows = probes.map(({ name, cmd }) => ({
  name,
  values: Object.fromEntries(
    names.map((snap) => [
      snap,
      snapshots[snap] ? run(cmd, snapshots[snap]) : '—',
    ]),
  ),
}));

console.log(`| Probe | ${names.join(' | ')} |`);
console.log(`| --- | ${names.map(() => '---').join(' | ')} |`);
for (const { name, values } of rows) {
  console.log(
    `| ${name} | ${names.map((snap) => values[snap].replaceAll('\n', ' · ')).join(' | ')} |`,
  );
}
if (
  rows.some(({ values }) =>
    Object.values(values).some((v) => v.startsWith('ERR')),
  )
) {
  console.error('some probes failed; fix them before using the numbers');
  process.exitCode = 1;
}
