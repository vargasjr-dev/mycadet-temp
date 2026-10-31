#!/bin/sh
# Android-QA drive: install the debug APK, launch the shell, and take the
# artifacts a QA session reads back (screencap, logcat). A dead process or a
# recorded crash fails the run; anything subtler is a human looking at the
# PNG through the sandbox's filesystem API.
#
# The launch sleep is TCG-sized: the Capacitor webview renders unaccelerated
# under SwiftShader, so give it a real moment before judging it.
set -eu

PACKAGE=ai.mycadet.android
ACTIVITY="${PACKAGE}/.MainActivity"
APK=${QA_APK_PATH:-/qa/clients/android/app/build/outputs/apk/debug/app-debug.apk}
ARTIFACTS=${QA_ARTIFACTS_DIR:-/qa/qa-artifacts}

mkdir -p "$ARTIFACTS"

adb install -r "$APK"

adb shell am start -n "$ACTIVITY"
sleep 30

adb exec-out screencap -p > "$ARTIFACTS/launch.png"

if [ -z "$(adb shell pidof "$PACKAGE" | tr -d '[:space:]')" ]; then
  echo "the ${PACKAGE} process is not running after launch" >&2
  adb logcat -d | tail -100 > "$ARTIFACTS/launch-logcat.txt" || true
  exit 1
fi

adb logcat -d > "$ARTIFACTS/logcat.txt" 2>/dev/null || true
if grep -q "FATAL EXCEPTION" "$ARTIFACTS/logcat.txt"; then
  echo "logcat records a FATAL EXCEPTION:" >&2
  grep -A 20 "FATAL EXCEPTION" "$ARTIFACTS/logcat.txt" | head -40 >&2
  exit 1
fi

echo "launched ${PACKAGE}; artifacts in ${ARTIFACTS}"
