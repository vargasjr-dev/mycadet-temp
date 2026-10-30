#!/usr/bin/env bash
# practice-build-remote-images.sh — build every remote sandbox image locally.
#
# Discovers each remote's Dockerfile (cli/src/lib/remotes/*/Dockerfile),
# stages its build context through the CLI's own staging code — the exact
# bytes `cadet hatch --remote <name>` uploads — and docker builds it.
#
# The release workflows' ci-remote-images job runs this to gate the
# @mycadet/cli publish: a broken image recipe (missing apt packages, bad bun
# pin, hatch regressions) stops the release before anything ships.
#
# The build pins the latest PUBLISHED mycadet: pre-publish, the version being
# released is not on npm yet, so this validates the image recipe; the
# release's own bits are validated by the ci-* family.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

published=$(npm view mycadet version)
echo "Practice-building remote images against published mycadet@${published}"

shopt -s nullglob
dockerfiles=(cli/src/lib/remotes/*/Dockerfile)
[ ${#dockerfiles[@]} -gt 0 ] || { echo "::error::no remote Dockerfiles found"; exit 1; }

for dockerfile in "${dockerfiles[@]}"; do
  remote=$(basename "$(dirname "${dockerfile}")")
  echo "== remote: ${remote} =="
  staged=$(bun cli/scripts/stage-remote-image-context.ts --remote "${remote}")
  sed -i "s/^ARG MYCADET_VERSION=.*/ARG MYCADET_VERSION=\"${published}\"/" "${staged}/Dockerfile"
  docker build -t "cadet-remote-practice:${remote}" "${staged}"
done
