#!/bin/bash

# In CI, browsers are installed separately via the playwright-install composite action
if [ "$CI" = "true" ]; then
    echo "⏭️  Skipping Playwright install in CI"
    exit 0
fi

# On Linux, --with-deps installs system packages as root. Without sudo, Playwright falls
# back to su, which reads its password from the piped stdin of this postinstall and so
# always fails, e.g. in Dependabot. sudo can prompt only if there is a terminal.
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null || \
       { ! sudo -n true 2>/dev/null && ! (: < /dev/tty) 2>/dev/null; }; then
        echo "⏭️  Skipping Playwright install: system deps need root, which is unavailable"
        exit 0
    fi
fi

yarn playwright install --with-deps chromium
