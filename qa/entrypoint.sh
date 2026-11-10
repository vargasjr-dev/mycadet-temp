#!/bin/sh
# Cadet-QA sandbox entrypoint.
#
# Sandbox startup order:
#   1. sandbox-api in the background — Baseten requires it and its process /
#      filesystem / port APIs are the platform's window into the sandbox.
#   2. keep the sandbox alive: QA is performed through the sandbox's control
#      plane (exec into the pulled repo, build the client under test, drive
#      it headless). Nothing runs ahead of the QA session here — no cadet
#      stack, no daemon, no wake, and the Android emulator boots only when a
#      run asks for it (./scripts/android/boot-emulator.sh): a run brings up
#      exactly the stack its scenario needs.
set -eu

/usr/local/bin/sandbox-api &

exec sleep infinity
