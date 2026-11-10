#!/bin/sh
# Cadet-QA sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. the state seed: when the session booted with the cadet-qa volume
#      mounted at /qa, the tree's .qa-state/seed-state.ts stamps the root
#      config through the CLI's own lockfile code (the prebuilt dists'
#      builtSha), so `cadet app start` serves the volume's dists instead of
#      rebuilding them on the sandbox's memory-backed disk. A no-volume boot
#      (bare image) simply has no seed and starts cold.
#   3. keep the sandbox alive: QA is performed through the sandbox's control
#      plane (exec into the pulled repo, build the client under test, drive
#      it headless). Nothing runs ahead of the QA session here — no cadet
#      stack, no daemon, no wake, and the Android emulator boots only when a
#      run asks for it (./scripts/android/boot-emulator.sh): a run brings up
#      exactly the stack its scenario needs.
set -eu

/usr/local/bin/sandbox-api &

if [ -f /qa/.qa-state/seed-state.ts ]; then
  (cd /qa && bun .qa-state/seed-state.ts) ||
    echo "[qa seed] state stamp failed — sessions will rebuild the dists" >&2
fi

exec sleep infinity
