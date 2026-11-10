# Cadet QA sandbox

One Baseten sandbox image (`cadet-qa`) for every client-QA need — desktop,
Android, web — and one session posture: create a sandbox from the image, exec
inside it, delete it. The image carries the toolchain and pulls the
open-source repo into `/qa` at build time; what you QA is what you run inside
the session, not a flag on the manager.

## What the image carries

| Layer    | Contents                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------- |
| shared   | git, jq, openssl, curl, unzip, ripgrep, procps, iproute2, lsof, less — the "look around inside" kit    |
| desktop  | Xvfb + the Electron/Chromium runtime libs (one set serves both — Playwright's browser needs the same) |
| android  | OpenJDK 21, Android cmdline-tools (pinned), platform-36, build-tools 36.0.0, emulator, platform-tools, a `google_apis` x86_64 system image — **best-effort, see below** |
| all      | bun (the release pipeline's pin) + the sandbox-api server (same digest pin as the cadet sandbox image) |

`google_apis`, not `google_apis_playstore` (what `clients/android/scripts/dev.ts`
uses on dev machines): Play-licensed images refuse adb root and buy a QA farm
nothing. Nothing in the image talks to Google Play, so Play-licensing behavior
of a store build is out of scope — as is iOS (the simulator and the .ipa build
are macOS-only; a device farm is the iOS answer, not this image).

## The Android layer is best-effort

Baseten's image builder cannot reach `dl.google.com` today (sdkmanager dies
with "IO exception while downloading manifest"), so the SDK step in the
Dockerfile tolerates failure: when Google's repository is unreachable the
layer writes `/opt/android-sdk/SDK-UNAVAILABLE` with the reason and the image
STILL BUILDS. Desktop and web QA are unaffected; the Android scenario fails
at run time (missing SDK) until the layer rebuilds somewhere with egress.

## KVM reality (read before expecting Android speed)

Baseten sandboxes are Firecracker microVMs, which expose no nested
virtualization — there is no `/dev/kvm` in the guest, so the emulator runs
**QEMU TCG (software emulation)**: boot takes minutes and UI interaction is
sluggish. `scripts/android/boot-emulator.sh start|wait` exists so a session
can overlap the boot with other work (start before Gradle, wait after). If a
host ever exposes `/dev/kvm`, the emulator picks acceleration up
automatically and everything just gets fast.

## Usage

```sh
bun qa/index.ts image push                        # once per toolchain change
bun qa/index.ts volume push                       # once per default-branch change
bun qa/index.ts create --name qa-desktop-1108     # image + memory are pinned here
bun qa/index.ts exec --name qa-desktop-1108 -- <command>...
bun qa/index.ts delete --name qa-desktop-1108
```

The Baseten CLI authenticates from `BASETEN_API_KEY` (vaulted as
`baseten:api_key` — pass it in the environment, never bake it into the
image).

## The volume: the QA tree rides outside the sandbox's disk

The sandbox's overlay filesystem is **memory-backed** — everything a session
writes (installs, builds, dists) shares the same 4 GB the processes need. A
full install plus a Vite build wedges the sandbox: `MemAvailable` collapses
while node_modules sit permanently in RAM, and every build gets OOM-killed.
The `cadet-qa` **volume** moves the heavy tree off that disk: it mounts at
`/qa` over the image's bare clone, so a session boots warm.

```sh
# assemble + publish (default-branch clone → install → both client builds
# → .qa-state boot seed); runs HERE, where memory isn't the ceiling.
# Namespaces are caller-chosen labels — the default is vargas-jr; override
# with --ref bdn:<namespace>/cadet-qa:qa or BASETEN_VOLUME_NAMESPACE.
bun qa/index.ts volume push

# pushes are content-deduplicated: a tree that mostly matches the current
# version uploads only what changed.
```

What the volume carries:

- the repo at its default branch (switch refs in-session as before),
- a full `bun install` — generated openapi client, Playwright's Chromium
  (the root `@playwright/browser-chromium` postinstall) — everything
  `--ignore-scripts` sessions previously had to fake,
- both client dists prebuilt, stamped fresh by the entrypoint's boot seed
  (`.qa-state/seed-state.ts` → the CLI's own `stampRootProcess`), so
  `cadet app start` serves the dists instead of building them.

The push flow is the ONLY supported way to get a build now: sessions should
not run `bun run build` for the web/app bundles (that is the wedge). A
no-volume session from the bare image still works for light work — it just
starts cold and must not build.

## Session cheatsheet

The image's `/qa` clone tracks the default branch; switch refs with an
ordinary `git -C /qa checkout <ref>` inside the session. Installs use
`--ignore-scripts` — the account ceiling is 4 GB of RAM and Electron's
binary download is the spike that OOMs an install (exit 137); the builds and
tests don't run that binary.

```sh
# desktop — build the Electron client, run its per-file suite under Xvfb
bun qa/index.ts exec --name qa-desktop-1108 -- \
  sh -c 'cd /qa && bun install --frozen-lockfile --ignore-scripts && cd clients/linux && bun install --frozen-lockfile --ignore-scripts && bun run build && xvfb-run -a bun scripts/run-tests.ts'

# android — boot the emulator (TCG: minutes), build, install, drive
bun qa/index.ts exec --name qa-android-1108 -- sh /qa/qa/scripts/android/boot-emulator.sh start
bun qa/index.ts exec --name qa-android-1108 -- \
  sh -c 'cd /qa/clients/android && bun install --frozen-lockfile --ignore-scripts && bun run build && ./gradlew assembleDebug'
bun qa/index.ts exec --name qa-android-1108 -- sh /qa/qa/scripts/android/boot-emulator.sh wait
bun qa/index.ts exec --name qa-android-1108 -- sh /qa/qa/scripts/android/drive.sh

# web — the image's Chromium libs cover the Playwright suite
bun qa/index.ts exec --name qa-web-1108 -- \
  sh -c 'cd /qa/clients/web && bun install --frozen-lockfile --ignore-scripts && bun run test'
```

## Why one image, one session (the direction)

The image pulls the repo into `/qa` and the sandbox-api control plane is a
general process/filesystem API — so a sandbox is as much a place to WORK on
the repo as to test it. A session can create a sandbox, exec inside, and
never touch a local clone at all, which keeps work safe from local worktree
and test-state clobbering. A full dev-session flow (attach, edit, run, push)
is the natural follow-up.
