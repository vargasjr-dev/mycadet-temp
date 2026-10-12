#!/usr/bin/env bash
#
# npm-generate-meta-shrinkwrap.sh
#
# Regenerate meta/npm-shrinkwrap.json from the stamped meta/package.json.
#
# npm only honors "overrides" in the root package.json, so they are ignored
# when end users run `npm install -g mycadet`. Shipping an npm-shrinkwrap.json
# generated with the overrides applied makes npm follow the same resolution
# for installed copies of the package.
#
# The install doubles as the release's only wait on the registry: `npm
# publish` exiting 0 does not mean the version can be installed yet — npm
# queues some publishes for asynchronous processing ("Your package is being
# processed and may take a few minutes to become available"), and the queue
# has held a package past fifteen minutes on a real release. The meta package
# is stamped to depend on exact versions published moments earlier, so early
# installs fail with ETARGET; poll until the deadline instead of failing the
# release on a slow queue.
#
# Usage:
#   ./scripts/npm-generate-meta-shrinkwrap.sh

set -euo pipefail

DEADLINE_SECONDS="${DEADLINE_SECONDS:-1800}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-20}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/meta"

deadline=$((SECONDS + DEADLINE_SECONDS))
attempt=0

until npm install --package-lock-only; do
  attempt=$((attempt + 1))
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::npm install --package-lock-only failed after ${DEADLINE_SECONDS}s across $attempt attempt(s) — the freshly published @mycadet/* versions may still be in npm's async processing queue"
    exit 1
  fi
  echo "npm install failed (attempt $attempt); retrying in ${POLL_INTERVAL_SECONDS}s..."
  sleep "$POLL_INTERVAL_SECONDS"
done

npm shrinkwrap
