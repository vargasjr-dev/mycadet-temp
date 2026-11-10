#!/bin/sh
# Cadet sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. state-volume seed — when the hatch mounted a persistent volume and
#      pointed the XDG homes at it (BASETEN_SANDBOX_VOLUME), the assistant's
#      state paths live there while the golden assistant was hatched at
#      build time into the image's own homes. On an empty volume the baked
#      state copies across once, so `cadet wake` finds the assistant it
#      expects; the volume then owns every write (the sandbox's own
#      filesystem is memory-backed — state written there dies with the
#      sandbox's RAM).
#   3. `cadet wake` in the background — brings up the hatched assistant
#      (daemon + gateway + CES) with its logs streaming to the sandbox
#      console.
#   4. `wait` — holds the container open. When either background job exits,
#      the container is considered dead and Baseten restarts it.
#
# The model loop runs IN the sandbox: the assistant daemon is the primary
# workload — sandbox-api is a control plane beside it, not a proxy in front
# of it.
set -eu

/usr/local/bin/sandbox-api &

if [ -d /data ] && [ ! -e /data/xdg-data/.cadet-golden-seeded ]; then
  mkdir -p /data/xdg-data /data/xdg-config
  cp -a /root/.local/share/. /data/xdg-data/ || true
  cp -a /root/.config/. /data/xdg-config/ || true
  touch /data/xdg-data/.cadet-golden-seeded
fi

cd /app
cadet wake &
wait
