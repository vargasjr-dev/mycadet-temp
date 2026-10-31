# Cadet QA sandbox

One Baseten sandbox image (`cadet-qa`) for every client-QA need — desktop,
Android, web. The image carries the toolchain and pulls the open-source repo
into `/qa` at build time; the runs build the client under test from the ref
they name and drive it headless inside the sandbox.

## What the image carries

| Layer    | Contents                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------- |
| shared   | git, jq, openssl, curl, unzip, ripgrep, procps, iproute2, lsof, less — the "look around inside" kit    |
| desktop  | Xvfb + the Electron/Chromium runtime libs (one set serves both — Playwright's browser needs the same) |
| android  | OpenJDK 21, Android cmdline-tools (pinned), platform-36, build-tools 36.0.0, emulator, platform-tools, a `google_apis` x86_64 system image |
| all      | bun (the release pipeline's pin) + the sandbox-api server (same digest pin as the cadet sandbox image) |

`google_apis`, not `google_apis_playstore` (what `clients/android/scripts/dev.ts`
uses on dev machines): Play-licensed images refuse adb root and buy a QA farm
nothing. Nothing in the image talks to Google Play, so Play-licensing behavior
of a store build is out of scope — as is iOS (the simulator and the .ipa build
are macOS-only; a device farm is the iOS answer, not this image).

## Scenarios (`run --target <desktop|android|web> [--ref <git-ref>]`)

- **desktop** — build `clients/linux` (Electron), then run its per-file test
  suite under `xvfb-run`. An app-driving tier (launch under Xvfb, screenshot)
  is the next step; today the tests are the desktop QA that runs.
- **android** — build the Capacitor bundle + `cap sync android`, boot the
  emulator, `gradlew assembleDebug`, install the APK, launch
  `ai.mycadet.android/.MainActivity`, screencap + logcat to
  `/qa/qa-artifacts/`; a dead process or a `FATAL EXCEPTION` fails the run.
- **web** — run `clients/web`'s test suite headless; the image's Chromium
  libs cover its Playwright browser tests.

Every scenario fetches the ref it names into the existing `/qa` clone (never
a fresh clone per run), installs, and builds from that tree.

## KVM reality (read before expecting Android speed)

Baseten sandboxes are Firecracker microVMs, which expose no nested
virtualization — there is no `/dev/kvm` in the guest, so the emulator runs
**QEMU TCG (software emulation)**: boot takes minutes and UI interaction is
sluggish. The android scenario is shaped for that: the emulator STARTS before
the Gradle build and the run WAITS for it after, overlapping the boot with
dependency downloads (`scripts/android/boot-emulator.sh start|wait`). If a
host ever exposes `/dev/kvm`, the emulator picks acceleration up
automatically and everything just gets fast.

## Usage

```sh
bun qa/index.ts image push                                   # once per toolchain change
bun qa/index.ts create --name qa-pr645
bun qa/index.ts run --name qa-pr645 --target android --ref <git-ref>
bun qa/index.ts boot --name qa-pr645                         # warm the emulator early
bun qa/index.ts exec --name qa-pr645 -- adb shell getprop sys.boot_completed
bun qa/index.ts delete --name qa-pr645
```

The Baseten CLI authenticates from `BASETEN_API_KEY` (vaulted as
`baseten:api_key` — pass it in the environment, never bake it into the
image).

## Why one image (the direction)

The image pulls the repo into `/qa` and the sandbox-api control plane is a
general process/filesystem API — so a sandbox is as much a place to WORK on
the repo as to test it. A session can create a sandbox, exec inside, and
never touch a local clone at all, which keeps work safe from local worktree
and test-state clobbering. The scenarios here are the first consumers of
that posture; a full dev-session flow (attach, edit, run, push) is the
natural follow-up.
