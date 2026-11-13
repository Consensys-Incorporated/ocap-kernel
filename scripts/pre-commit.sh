#!/bin/bash

set -e

# Dependabot's updater image sets DEPENDABOT and commits locally between updates. Its
# lockfile isn't deduped until .github/workflows/dependabot-dedupe.yml runs on the PR.
if [ -n "$DEPENDABOT" ]; then
    echo "⏭️  Skipping pre-commit hook in Dependabot"
    exit 0
fi

yarn lint-staged
yarn dedupe --check
