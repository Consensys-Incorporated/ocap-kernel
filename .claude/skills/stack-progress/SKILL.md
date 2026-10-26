---
name: stack-progress
description: Build or refresh a visual progress page for a PR stack or epic — where the code started, where it is now, and what the stack is aiming at — as snapshot diagrams with a measured comparison table. Use when asked for a stack overview, progress page, before/after diagram, or "where are we" on a series of PRs, given a root PR number, branch list, or existing page URL.
---

Produces one page that shows a PR stack as **snapshots of one structure**:
the same diagram, same layout, drawn at each point in time, with a table of
measured properties across the snapshots. The reference example is the
_Run Loop Progress_ page (the KernelQueue run loop as a state machine before
the store epic, on `main` today, at the one-writer target, and after #1168).

Invoked as `/stack-progress <root PR | branch,branch,… | page URL> [subject hint]`.
With a page URL, refresh that page in place (step 9).

The page answers three questions, in this order:

1. **Where we started.** The code before the stack's first change.
2. **Where we are.** What has landed, what is built but unmerged, and how far
   the base branch has moved underneath it.
3. **What we're aiming at.** The target the PRs and plan docs describe.

Everything on the page is read from the repository or the PRs. Numbers come
from the probe script, not from memory. A proposal is labelled as one.

## 1. Discover the stack

Get the PR chain, root first: PR number, title, state (open/merged/closed),
head branch, base branch.

- With `gh`: `node .claude/skills/stack-progress/scripts/stack-facts.mjs --pr <N>`
  walks the chain itself (each next PR is the one whose base is the previous
  head) and warns where the stack forks.
- Without `gh` (cloud sessions): use the GitHub MCP tools. `pull_request_read`
  the root, then `search_pull_requests` / `list_pull_requests` for PRs whose
  `base` is its head branch, and repeat. Also check the branch graph directly:
  for each candidate branch, `git merge-base --is-ancestor <parent> <child>`.

Read every PR body; they name plan docs, issues, deferred phases and
follow-ups. Note any plan docs (`docs/plans/**`, ADRs) in the stack's own
branches: they are the source for the target snapshot.

## 2. Collect the git facts

```bash
git rev-parse --is-shallow-repository   # if true: git fetch --unshallow origin
git fetch origin <every stack branch> main
node .claude/skills/stack-progress/scripts/stack-facts.mjs \
  --branches <root-branch>,…,<tip-branch> \
  --paths <the stack's subject paths, comma-separated> \
  > "$SCRATCH/facts.json"
```

It reports the fork point, each layer's commits and per-package diffstat,
the base branch's commits since the fork that touch `--paths` (drift), files
both sides changed (overlap), and the files a trial merge of the tip into the
base would conflict on. Pass `--paths` narrowly (the subsystem, not whole
packages), or drift fills up with repo-wide churn.

Merged layers: when some PRs already merged, the stack branches may be gone.
Use the merge commits on the base branch instead (`git log --merges`, or the
PR's `merge_commit_sha`), and take the fork point as the base branch just
before the first merged PR.

## 3. Choose the snapshots

Two to four snapshots, lettered A–D in time order. Pick from:

| Snapshot   | Revision                                                           | Include when                                                            |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Started    | the fork point, or the base branch just before the first merged PR | always                                                                  |
| Base today | the base branch head                                               | some layers merged, or drift touched the subject                        |
| Stack tip  | the top unmerged branch                                            | some layers are unmerged                                                |
| Target     | none: plan docs, PR bodies, issues                                 | the plans go past the tip (deferred phases, follow-ups, a later design) |

When nothing has merged, "where we are" has two parts: the built-but-unmerged
tip, and the base branch that moved under it. Keep "base today" as a snapshot
anyway, since its column in the table shows whether the base moved the
subject. If its diagram would equal A's, give it a section without a diagram:
"B has the same diagram as A", then a table of the drift commits that changed
behaviour inside the boxes, with where the stack now holds that code, and the
trial-merge conflict count split into subject code and churn (changelogs,
manifests, lockfiles).

Each snapshot tile gives `ref · short sha · date`, or `proposal`.

## 4. Choose the subject and the diagram form

The subject is the one structure the stack changes. Name it in one phrase
("the KernelQueue run loop", "remote comms from runtime to transport"). Pick the
form that makes the stack's change visible as a change of **colour, presence
or edges on a fixed layout**:

- **State machine**: when the stack changes what happens in each state or
  transition (run loops, lifecycles, protocols).
- **Layered module / package diagram**: when the stack moves code between
  modules or packages, or cuts a dependency (extractions, seams, plug-ins).
- **Data flow**: when the stack changes who writes or reads what, or in what
  order.

Then fix the colour roles. Each node gets exactly one:

- `hazard`: has the property the stack removes (shared writer, a libp2p import, an early send).
- `goal`: has the property the stack wants.
- `alt`: a second acceptable kind (another owner, an optional implementation).
- `none`: neutral or out of scope.

Dashed stroke marks a node new since the previous snapshot. A removed node
is left out, and the "X → Y" list says where it went.

Write the legend text before drawing. If a node fits two roles, the roles
are wrong: re-cut them.

## 5. Research each snapshot

For more than two snapshots, spawn one subagent per snapshot or pair of
snapshots, in parallel. Each gets the same brief, so the diagrams line up:

- The revision(s), and the rule: read with `git show <rev>:<path>`,
  `git grep <pat> <rev> -- <path>`, `git ls-tree`. Never check out.
- The subject, the diagram form, and the colour roles from step 4.
- What to return: 10–16 nodes with role, one-line behaviour, and a
  file:line cite each; edges with labels and cites; for a later snapshot,
  only what differs from the earlier one, with the PR that changed it.
- For the base-today snapshot: what the drift commits changed in the subject,
  one line each, since these are what a rebase must carry.
- For the target snapshot: plan docs only, quoting the doc's own words for
  anything open or undecided, with file and heading.
- "Say unsure rather than guess", and a word cap (about 1200).

Do the small cases (one or two snapshots, a subject in a few files) yourself.

## 6. Measure

Choose 5–10 properties that tell the story, and write each as a shell probe
that prints one short value at a revision. Run them all at once:

```bash
node .claude/skills/stack-progress/scripts/probe.mjs "$SCRATCH/probes.json"
```

(The file format is in the script's header.) Good probes count or test something the stack
is about: imports of a dependency from a directory, files in a package,
exported names, whether a function exists, deps in a `package.json`. Target
snapshots have no revision; their values come from the plan and the cell
says so ("planned", "0 (plan)").

Every number on the page must trace to a probe or a cited line. A probe
that errors or returns something surprising is a finding to check, not a
cell to fill in.

## 7. Write the page

If an `artifact-design` skill or Artifact quickstart is available, load it
first. Copy `template.html` to the scratchpad and fill it in. Generate the SVGs
with `scripts/svg-kit.mjs` from a small build script in the scratchpad: one
function takes the snapshot letter and emits that snapshot's diagram from a
single layout, which keeps positions identical across snapshots. Order:

1. Eyebrow, title (two to four words), lede: the subject, the snapshots, and
   the one thing that holds in every diagram.
2. Snapshot strip, legend.
3. **Summary**: 3–5 findings, each a bolded claim backed by a number from the
   table: how far the stack has got, what remains, what the base branch's drift
   costs (conflicting files, commits to carry), what the target still has open.
4. Comparison table.
5. One section per snapshot: a meta line with the exact ref and the PRs it
   contains (link them in full: `https://github.com/<owner>/<repo>/pull/<n>`), the
   diagram, a caption saying what to notice, a node table, and from the second
   snapshot on an "X → Y" list of changes, each with its PR.
6. For an open target, a `.note` with the questions the plan leaves open.
7. Footer: which files at which revisions each diagram was read from.

Diagram rules:

- One `viewBox` and one layout for every snapshot. Lay out the most crowded
  snapshot first, then derive the others by recolouring, dashing, adding and
  dropping nodes. A node that persists keeps its position.
- Orthogonal edges, ending 2px short of their target. Labels sit beside lines,
  never on them. 13px mono names, 11.5px body lines, at most three lines per node.
- Colours only through the CSS tokens, so dark mode works.
- An `aria-label` on each SVG that describes the diagram in a paragraph.

Prose follows `.claude/skills/prose-pass/SKILL.md`: say what changed and why it
matters, cut what a reader can derive from the diagram.

## 8. Check

```bash
node .claude/skills/stack-progress/scripts/check-page.mjs "$SCRATCH/<page>.html"
```

It renders desktop and phone in light and dark, writes screenshots, and
fails on colliding SVG labels, labels spilling out of their box, sideways
page scroll, and script errors. Fix every fault, then Read the per-diagram
screenshots (`check-diagram-<n>-<scheme>.png`; the full-page ones are too
small to judge) and look at each diagram: crossing edges, an edge through a
node, a label on the wrong edge, a node coloured against its role.

For a page with more than a handful of claims, have a fresh subagent
fact-check it: give it the page and the revisions, not your notes, and ask
for every claim it cannot verify from the repository.

## 9. Publish or refresh

Publish the page with the Artifact tool (icon `chart`) and give the link. With
no Artifact tool, save the HTML where the user can open it and say where.

To refresh a page later (`/stack-progress <page URL>`): read it, keep
snapshot A and the layout, move "base today" and "stack tip" to the current
revisions, re-run steps 2, 5 (only for what moved) and 6, and republish to the
same URL. Say in the meta line what changed since the last version.
