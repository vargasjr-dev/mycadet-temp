#!/bin/sh
# Android-QA sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. keep the sandbox alive: QA is performed through the sandbox's control
#      plane (exec into the pulled repo, build clients/android, drive the APK
#      on a headless emulator). Nothing runs ahead of the QA session here —
#      the emulator boots when a run asks for it (./scripts/boot-emulator.sh),
#      not at sandbox start: TCG boots cost minutes, and an emulator coming
#      up on every create would tax every idle sandbox.
set -eu

/usr/local/bin/sandbox-api &

exec sleep infinity
