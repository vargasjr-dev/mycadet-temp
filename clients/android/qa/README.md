# Android-QA sandbox for Baseten

One sandbox = one QA run of the Android client. The image carries the
toolchain (JDK 21, the Android SDK — platform 36 / build-tools 36.0.0, the
emulator, adb — and bun) plus the open-source repo pulled at build time into
`/qa`; the runs build `clients/android` inside the sandbox from the ref they
name and drive the APK on a headless emulator. Modeled on the desktop-QA
image (`clients/linux/qa`), which carries the sandbox-api control plane
contract the platform expects.

## KVM reality (read before expecting speed)

Baseten sandboxes are Firecracker microVMs, which expose no nested
virtualization — there is no `/dev/kvm` in the guest, so the emulator runs
in **QEMU TCG (software emulation)**: boot takes minutes and UI interaction
is sluggish. The pipeline is shaped for that: the emulator STARTS before the
Gradle build and the run WAITS for it after, overlapping the boot with
dependency downloads (`scripts/boot-emulator.sh start|wait`). If a host ever
exposes `/dev/kvm`, the emulator picks acceleration up automatically and
everything just gets fast.

What this tier covers: the APK builds, installs, boots, launches
`ai.mycadet.android/.MainActivity`, renders (screencap), and survives
logcat without a `FATAL EXCEPTION` — artifacts land in `/qa/qa-artifacts/`
(`launch.png`, `logcat.txt`), readable through the sandbox's filesystem API.
What it does not: Google Play licensing behavior (the image installs the
`google_apis` image, not `google_apis_playstore`), real-device specifics,
and iOS — the iOS simulator and the .ipa build are macOS-only; the iOS
answer is a device farm, not this image.

## Usage

```sh
bun clients/android/qa/index.ts image push                          # once per toolchain change
bun clients/android/qa/index.ts create --name android-qa-pr635
bun clients/android/qa/index.ts run --name android-qa-pr635 --ref <git-ref>
bun clients/android/qa/index.ts exec --name android-qa-pr635 -- adb shell getprop sys.boot_completed
bun clients/android/qa/index.ts delete --name android-qa-pr635
```

`boot` warms the emulator ahead of a session (`start` + `wait`); `run`
drives the whole pipeline. The Baseten CLI authenticates from
`BASETEN_API_KEY` (vaulted as `baseten:api_key` — pass it in the
environment, never bake it into the image).
