# Cadet Windows app

Electron shell around the shared `clients/web` renderer: in dev it attaches
to `vel up` (or a standalone Vite), and packaged builds serve the bundled
runtime over a privileged `app://` protocol. The bridge to the main process
is the shared static preload in `@mycadet/electron-desktop`
(`src/preload/index.ts` is a one-line import), and
`src/preload/bridge-parity.test.ts` holds the composed bridge to the full
`CadetBridge` contract.

The Windows helper (`native/Cadet.WindowsHelper`) is the same-user,
non-elevated JSON-RPC process behind UI Automation observation, verified
input, dictation, toasts, and text insertion; its security model is in
[`native/README.md`](native/README.md). `native/Cadet.PreviewHandler` is
the Explorer preview and thumbnail handler for `.cadet` bundles.

## Development

```bash
bun run dev
```

Probes for `vel up` at `localhost:3000` and attaches to it, or falls back to
standalone mode (spawns `clients/web`'s Vite on :5173, shell only, no
backends). Scripts assume a POSIX shell; on Windows use Git Bash (or WSL).

## Packaging and releases

```bash
bun run pack        # dev installer for testing on another machine
bun run pack:debug  # dev installer with Chrome DevTools enabled
```

`pack` builds every bundled resource (CLI runtime, native helper, preview
handler) before `electron-builder`; local and CI packs are unsigned, and
`.github/workflows/windows-package-smoke.yaml` install-, launch-, and
uninstall-tests the installer per architecture. Packaged builds
self-update through `electron-updater` from the per-channel release feed.

## Checks

```bash
bun run typecheck
bun run test:ci
```
