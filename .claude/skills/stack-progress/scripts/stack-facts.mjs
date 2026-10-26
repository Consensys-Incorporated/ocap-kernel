#!/usr/bin/env node
// Collects the git facts a stack-progress page is built on: where the stack
// forked from the base branch, what each layer changes, and where the base
// branch has since moved under the stack.
//
//   node stack-facts.mjs --branches a,b,c [--base origin/main] [--paths pkg/a,pkg/b]
//   node stack-facts.mjs --pr 970 [--repo owner/name]   (walks the stack with `gh`)
//
// Writes JSON to stdout. Branch order is root first; `--pr` derives it.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    branches: { type: 'string' },
    pr: { type: 'string' },
    repo: { type: 'string' },
    base: { type: 'string', default: 'origin/main' },
    paths: { type: 'string' },
  },
});

const git = (...argv) =>
  execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const lines = (text) => (text ? text.split('\n') : []);

const ghJson = (argv) =>
  JSON.parse(execFileSync('gh', argv, { encoding: 'utf8' }));

/**
 * Walk a PR stack upward from its root: each next PR is the open or merged PR
 * whose base is the previous PR's head branch.
 *
 * @param {number} root - The root PR number.
 * @returns {{ number: number, branch: string, title: string, state: string }[]} The stack, root first.
 */
function discoverStack(root) {
  const repoArgs = args.repo ? ['--repo', args.repo] : [];
  const fields = 'number,title,state,headRefName,baseRefName,mergedAt';
  const first = ghJson([
    'pr',
    'view',
    String(root),
    '--json',
    fields,
    ...repoArgs,
  ]);
  const stack = [first];
  for (;;) {
    const head = stack.at(-1).headRefName;
    const children = ghJson([
      'pr',
      'list',
      '--state',
      'all',
      '--base',
      head,
      '--json',
      fields,
      ...repoArgs,
    ]);
    if (children.length === 0) {
      break;
    }
    if (children.length > 1) {
      console.error(
        `stack forks at ${head}: ${children.map((pr) => `#${pr.number}`).join(', ')}; following the oldest`,
      );
    }
    stack.push(children.sort((a, b) => a.number - b.number)[0]);
  }
  return stack.map((pr) => ({
    number: pr.number,
    branch: pr.headRefName,
    title: pr.title,
    state: pr.mergedAt ? 'MERGED' : pr.state,
  }));
}

const stack = args.pr
  ? discoverStack(Number(args.pr))
  : args.branches.split(',').map((branch) => ({ branch }));

const remoteRef = (branch) =>
  branch.includes('/') && git('branch', '-r', '--list', branch)
    ? branch
    : `origin/${branch}`;

if (git('rev-parse', '--is-shallow-repository') === 'true') {
  console.error(
    'shallow clone: run `git fetch --unshallow` first, or merge bases are wrong',
  );
  process.exit(1);
}

const base = args.base;
const tip = remoteRef(stack.at(-1).branch);
const forkPoint = git('merge-base', base, tip);
const commitInfo = (rev) => {
  const [sha, date, subject] = git(
    'log',
    '-1',
    '--format=%h%x09%cs%x09%s',
    rev,
  ).split('\t');
  return { sha, date, subject };
};

/**
 * Sum a diff's numstat per top-level area (`packages/<name>`, else the first path segment).
 *
 * @param {string} from - Start revision.
 * @param {string} to - End revision.
 * @returns {object} Files and line counts, total and per area.
 */
function diffSummary(from, to) {
  const areas = {};
  const files = [];
  for (const row of lines(git('diff', '--numstat', '-M', from, to))) {
    const [added, removed, file] = row.split('\t');
    const path = file.includes('=>')
      ? file.replace(/\{?[^{]*=> ([^}]*)\}?/u, '$1')
      : file;
    const parts = path.split('/');
    const area =
      parts[0] === 'packages' ? parts.slice(0, 2).join('/') : parts[0];
    areas[area] ??= { files: 0, added: 0, removed: 0 };
    areas[area].files += 1;
    areas[area].added += Number(added) || 0;
    areas[area].removed += Number(removed) || 0;
    files.push(path);
  }
  return { files, areas };
}

let previous = forkPoint;
const layers = stack.map((layer) => {
  const ref = remoteRef(layer.branch);
  const { files, areas } = diffSummary(previous, ref);
  const commits = lines(
    git('log', '--format=%h %cs %s', `${previous}..${ref}`),
  );
  const entry = {
    ...layer,
    ref,
    head: commitInfo(ref),
    commits,
    areas,
    fileCount: files.length,
  };
  previous = ref;
  return entry;
});

const stackDiff = diffSummary(forkPoint, tip);
const watched = args.paths
  ? args.paths.split(',')
  : Object.keys(stackDiff.areas);
const drift = lines(
  git('log', '--format=%h %cs %s', `${forkPoint}..${base}`, '--', ...watched),
);
// --no-renames keeps both ends of a move, so a file the stack moved away and
// the base branch kept editing still counts.
const baseChanged = new Set(
  lines(git('diff', '--name-only', '--no-renames', forkPoint, base)),
);
const overlap = lines(
  git('diff', '--name-only', '--no-renames', forkPoint, tip),
).filter((file) => baseChanged.has(file));

/**
 * Trial-merge the stack tip into the base branch without touching the work tree.
 *
 * @returns {string[]} Paths that conflict.
 */
function trialMerge() {
  try {
    git(
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      base,
      tip,
    );
    return [];
  } catch (error) {
    // Exit status 1 means conflicts: line 1 is the tree id, then one path per line.
    if (error.status !== 1) {
      throw error;
    }
    return lines(String(error.stdout).trim()).slice(1);
  }
}
const conflicts = [...new Set(trialMerge())];

console.log(
  JSON.stringify(
    {
      base: { ref: base, head: commitInfo(base) },
      forkPoint: commitInfo(forkPoint),
      baseAheadOfFork: Number(
        git('rev-list', '--count', `${forkPoint}..${base}`),
      ),
      layers,
      stack: { fileCount: stackDiff.files.length, areas: stackDiff.areas },
      drift: { paths: watched, commits: drift },
      overlap,
      conflicts,
    },
    null,
    2,
  ),
);
