#!/bin/sh
# Cadet sandbox entrypoint.
#
# Sandbox startup order:
#   1. the instance's bin/ shims are materialized and their dir prepended to
#      PATH. Sandbox execs inherit THIS process's environment, fixed before
#      `cadet wake` ever runs, so the shim dir must be on PATH from the
#      start — the shims land inside it here and every wake after refreshes
#      them. They resolve the cadet binaries to the sandbox's own install,
#      the same build the daemon stack runs. Best effort: a resolution
#      failure leaves PATH untouched.
#   2. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   3. `cadet wake` in the background — brings up the hatched assistant
#      (daemon + gateway + CES) with its logs streaming to the sandbox
#      console. When the hatch mounted a state volume it pointed the XDG
#      homes at it at create time, so every write below lands there.
#   4. `wait` — holds the container open. When either background job exits,
#      the container is considered dead and Baseten restarts it.
#
# The model loop runs IN the sandbox: the assistant daemon is the primary
# workload — sandbox-api is a control plane beside it, not a proxy in front
# of it.
set -eu

SHIM_DIR=$(bun -e '
  const { readLockfile, ensureLocalBinShims } = require("@mycadet/local-mode");
  const entry = readLockfile().assistants.find((a) => a.cloud === "local");
  if (entry) process.stdout.write(ensureLocalBinShims(entry).dir);
' 2>/dev/null || true)
export PATH="${SHIM_DIR:+$SHIM_DIR:$PATH}"

/usr/local/bin/sandbox-api &

cd /app
cadet wake &
wait
