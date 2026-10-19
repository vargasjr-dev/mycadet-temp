# clients/

Home for end-user client surfaces of the Cadet assistant — browser, mobile,
and desktop wrappers that users interact with directly.

## Structure

```
clients/
├── app/               # Account client (Vite), to be bundle split from Web in the future
├── web/               # Assistant web bundle (Vite)
├── docs/              # Public docs site: SSR Next.js app serving mycadet.ai/docs
├── ios/               # iOS Capacitor shell
├── android/           # Android Capacitor shell
├── macos/             # macOS desktop wrapper (Electron / electron-vite)
├── linux/             # Linux desktop wrapper (Electron / electron-vite, AppImage)
├── windows/           # Windows desktop wrapper (Electron / electron-vite)
└── chrome-extension/  # MV3 Chrome browser extension
```

The iOS app is a Capacitor shell that lives in [`ios/`](./ios/); it boots a
baked `@mycadet/app` boot bundle (the initial Cadet screens) and hands off to
the deployed assistant entry over HTTPS.

The Android app is a Capacitor shell that lives in [`android/`](./android/);
it follows the same baked boot-bundle model as iOS.

The macOS, Linux, and Windows Electron shells share their platform-neutral main and
preload foundations through `@mycadet/electron-desktop` and native helper process supervision through `@mycadet/native-sidecar`. Thin client adapters
under each platform package connect that core to platform lifecycle and native
features. Dependency-free Electron helpers remain in `@mycadet/electron-utils`.

The desktop shells are joining the app/web split:
the main window renders the `@mycadet/app` shell and iframes the web bundle
served from the assistant, while auxiliary windows keep their web routes.
macOS flipped first; Linux and Windows follow the same pattern.

## What belongs here

- End-user client surfaces (web app, Capacitor wrappers, Electron desktop
  wrappers, Chrome extension).

## What does not belong here

- Shared libraries — these live in `packages/`.
- Backend services — `assistant/`, `gateway/`, `credential-executor/`, `cli/`
  stay at the repo root.

## Conventions

- `web/`, `macos/`, `linux/`, `windows/`, and `docs/` are members of the root bun
  workspace: the single root `bun.lock` covers them, and `bun install` anywhere in the tree
  resolves to the workspace root. Each keeps its own `package.json`,
  `tsconfig.json`, and lint config.
- `chrome-extension/` is the one standalone package, with its own `bun.lock`
  and per-package `bun install`. Native shells (`ios/`, `android/`) are
  Capacitor shells that build from the `@mycadet/app` config package and
  carry their own package manifests (both root-workspace members).
- Exact version pinning applies repo-wide (see root [`AGENTS.md`](../AGENTS.md)).
- When a new client is added under `clients/`, add corresponding `paths:` globs
  to any relevant PR/CI workflows in `.github/workflows/`.

## Notes

- **macOS workflow filenames** — `clients/macos/` is the canonical
  platform-named directory, and its CI workflow files are `pr-macos.yaml` /
  `ci-main-macos.yaml`.
- **Windows workflow filenames** - `clients/windows/` uses `pr-windows.yaml` /
  `ci-main-windows.yaml`.
- **Linux workflow filenames** - `clients/linux/` uses `pr-linux.yaml` /
  `ci-main-linux.yaml`.
- **Desktop parity** - the Electron shells expose the same `CadetBridge`
  contract from `packages/ipc-contract`; `clients/windows/docs/parity-matrix.md`
  maps each capability to its Windows module, macOS counterpart, and test, and
  names the macOS concepts with no Windows equivalent.

## Chrome Extension

See [`chrome-extension/README.md`](chrome-extension/README.md) for build, load,
environment, and publishing instructions.
