#!/bin/sh
# Cadet sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. `cadet wake --foreground` — wakes the hatched assistant (daemon +
#      gateway + CES) and streams their logs to the sandbox console. The
#      foreground block is the keep-alive: when it exits, the sandbox is
#      considered dead and Baseten restarts it.
#
# The model loop runs IN the sandbox, so the assistant daemon is the primary
# workload — sandbox-api is a control plane beside it, not a proxy in front
# of it.
set -eu

/usr/local/bin/sandbox-api &

cd /app
exec cadet wake --foreground
