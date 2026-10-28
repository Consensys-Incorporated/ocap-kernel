#!/usr/bin/env bash

# Judge the trials of .github/workflows/performance.yml. Each trial leaves vitest
# JSON reports under its own directory in the given one. A test regresses when
# it fails in at least MIN_FAILURES trials; then one open issue labeled LABEL
# tracks it, and later runs comment there instead of opening another.
#
# Tests may record `ratio` and `bound` in their task meta for the summary.
#
# Usage: performance-verdict.sh <reports-dir>
# Env: MIN_FAILURES, LABEL, RUN_URL, GITHUB_STEP_SUMMARY, and what `gh` needs.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <reports-dir>"
  exit 1
fi

reports_dir="$1"
trials=$(find "$reports_dir" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')

# Too few trials and a majority can't be reached.
if ((trials < MIN_FAILURES)); then
  echo "::error::Only ${trials} trials produced a report"
  exit 1
fi

results=$(find "$reports_dir" -name '*.json' -type f -exec jq -s '
  [.[].testResults[]
    | (.name | sub("^.*?/packages/"; "packages/")) as $file
    | .assertionResults[]
    | . + { key: "\($file) > \(.fullName)" }]
  | group_by(.key)
  | map({
      key: .[0].key,
      bound: (map(.meta.bound // empty) | first),
      ratios: map(.meta.ratio // empty),
      failed: map(select(.status != "passed")) | length
    })' {} +)

summary=$(jq -r --arg trials "$trials" '
  .[]
  | "- **\(.key)**: failed in \(.failed) of \($trials) trials."
    + if (.ratios | length) > 0 then
        " Ratios \(.ratios | map(. * 100 | round / 100 | tostring) | join(", "))"
        + " against a bound of \(.bound // "?")."
      else "" end' <<<"$results")
echo "$summary" >>"$GITHUB_STEP_SUMMARY"

regressed=$(jq --argjson min "$MIN_FAILURES" 'any(.[]; .failed >= $min)' <<<"$results")
existing=$(gh issue list --label "$LABEL" --state open --json number --jq '.[0].number // empty')

if [[ "$regressed" != true ]]; then
  if [[ -n "$existing" ]]; then
    gh issue comment "$existing" --body "Passed on ${RUN_URL}

${summary}"
  fi
  exit 0
fi

if [[ -n "$existing" ]]; then
  gh issue comment "$existing" --body "Still failing on ${RUN_URL}

${summary}"
else
  gh label create "$LABEL" --force --color B60205 \
    --description 'Scheduled performance tests failed'
  gh issue create --label "$LABEL" \
    --title 'Performance tests failed in most trials' \
    --body "Most trials of the performance tests failed on ${RUN_URL}. Later runs comment here instead of opening a new issue; close this once it's fixed or explained.

${summary}"
fi
exit 1
