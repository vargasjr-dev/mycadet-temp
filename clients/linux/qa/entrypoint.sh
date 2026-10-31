#!/bin/sh
# Desktop-QA sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. `cadet wake --foreground` — wakes the hatched assistant (daemon +
#      gateway + CES) and streams their logs to the sandbox console. The
#      foreground block is the keep-alive: when it exits, the sandbox is
#      considered dead and Baseten restarts it.
#
# The desktop client under test launches AFTER the stack is up: the QA run
# execs into the sandbox, starts Xvfb on its own display number, and drives
# the client against the gateway the wake brought up. sandbox-api is a
# control plane beside the stack, not a proxy in front of it.
set -eu

/usr/local/bin/sandbox-api &

cd /app
exec cadet wake --foreground
