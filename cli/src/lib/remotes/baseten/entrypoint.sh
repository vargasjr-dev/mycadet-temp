#!/bin/sh
# Cadet sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. `cadet wake` in the background — brings up the hatched assistant
#      (daemon + gateway + CES) with its logs streaming to the sandbox
#      console.
#   3. `wait` — holds the container open. When either background job exits,
#      the container is considered dead and Baseten restarts it.
#
# The model loop runs IN the sandbox, so the assistant daemon is the primary
# workload — sandbox-api is a control plane beside it, not a proxy in front
# of it.
set -eu

/usr/local/bin/sandbox-api &

cd /app
cadet wake &
wait
