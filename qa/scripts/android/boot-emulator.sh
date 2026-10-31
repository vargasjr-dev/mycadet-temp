#!/bin/sh
# Android-QA emulator boot, in two modes — the android scenario starts the
# emulator BEFORE the Gradle build and waits for it after, overlapping the
# emulator's slow software-emulated boot with dependency downloads:
#
#   boot-emulator.sh start  — create the AVD if missing and launch the
#                             emulator headless in the background; returns
#                             immediately. Idempotent: a running device
#                             short-circuits.
#   boot-emulator.sh wait   — block until sys.boot_completed=1 (or time out
#                             with the emulator log's tail on stderr).
#
# Acceleration: the emulator auto-detects KVM and uses it when a host ever
# exposes /dev/kvm; on Baseten (Firecracker microVM, no nested virt) it runs
# QEMU TCG, so the flags bias to software rendering and minimal services —
# SwiftShader GPU, no snapshots, no cameras, no audio.
set -eu

API_LEVEL=36
AVD=${QA_ANDROID_AVD:-cadet-api-36}
IMAGE="system-images;android-${API_LEVEL};google_apis;x86_64"
LOG=${QA_EMULATOR_LOG:-/tmp/emulator.log}
BOOT_TIMEOUT=${QA_ANDROID_BOOT_TIMEOUT:-1800}

device_online() {
  adb get-state 2>/dev/null | grep -q device
}

start() {
  if device_online; then
    echo "emulator already running"
    return 0
  fi
  if ! avdmanager list avd 2>/dev/null | grep -q "Name: ${AVD}"; then
    echo no | avdmanager create avd \
      -n "$AVD" -k "$IMAGE" -d pixel_5 --force
  fi
  nohup emulator -avd "$AVD" \
    -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect \
    -no-snapshot -camera-back none -camera-front none \
    -memory 3072 \
    >"$LOG" 2>&1 &
  adb start-server
}

wait_boot() {
  adb wait-for-device
  waited=0
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ]; do
    sleep 10
    waited=$((waited + 10))
    if [ "$waited" -ge "$BOOT_TIMEOUT" ]; then
      echo "emulator not booted after ${BOOT_TIMEOUT}s — last log lines:" >&2
      tail -20 "$LOG" >&2 || true
      exit 1
    fi
  done
  echo "emulator booted (waited ${waited}s)"
}

case "${1:-}" in
  start) start ;;
  wait) wait_boot ;;
  *) echo "usage: $0 <start|wait>" >&2; exit 2 ;;
esac
