# Desktop App Shell Flip — the Electron shells hang off @mycadet/app

> **Status:** proposal → in progress. macOS lands first; linux/windows follow the
> same pattern in copy-shaped follow-ups. The durable architecture reference after
> landing is `clients/README.md` + `packages/electron-desktop`.

## Why now

The first Cadet user request aimed at the desktop app arrived. Supporting it in the
desktop client means building on the **app shell** (`@mycadet/app`), not the web
shell (`@mycadet/web`) — the same commitment the mobile shells already made in
#387 ("commit the mobile shells to the app/web split"). The desktop shells are the
last client surfaces still serving the web bundle as their renderer root, and every
desktop-side feature from here on (account surfaces, assistant selection,
desktop login, create-assistant flows) is app-shell code that web should never
grow.

Today's desktop topology (all three shells):

- The Electron main process serves a locally bundled **web** dist
  (`resources/web-dist`, dev: `clients/web/dist`) over the privileged
  `app://mycadet.ai/assistant/` mount (web builds with `base: "/assistant/"`).
- The renderer IS the web SPA. Everything account-shaped (login, assistant
  resolution, selection) is either native-bridge code or web code — there is no
  shell.

Target topology:

- The renderer root serves the **app** dist (`@mycadet/app` standalone build,
  root-based SPA, `base: "/"`) at `app://mycadet.ai/` — mounted at `/`, not
  `/assistant`.
- The web bundle remains **iframe content served from the assistant**: the app
  shell's `AssistantFrame` points at the resolved assistant's edge
  (`AssistantResolution.ready.assistant.url`), exactly like the hub and the
  mobile shells. Desktop never ships the web dist again.
- The account surface talks to the cloud platform through the same-origin
  forwards the desktop already owns (`/v1/*`, `/_allauth/*`, `/accounts/*` →
  cloud API), plus the `cadet` bridge the app package already speaks
  (`@app/runtime/electron-bridge.ts`: `auth`, `menu`, `mainWindow`, `commands`,
  `localMode`).

## What already exists (verified)

| Piece | Where | State |
| --- | --- | --- |
| Portable app shell (`AppShell`, resolution, selection) | `clients/app/src/app-shell.tsx`, `src/assistant/*` | Shipped; hub + mobile render it today |
| Standalone desktop-shaped entry (router, DesktopChrome, AssistantPage) | `clients/app/src/standalone.tsx`, `src/main.tsx` | Shipped; reads injected config |
| Electron bridge contract the app expects | `clients/app/src/runtime/electron-bridge.ts` | Shipped |
| Electron preload exposing that bridge (`auth.startOAuth`, `menu.setCloudSession`, `mainWindow.*`, `commands.on`) | `clients/macos/src/preload/index.ts` (linux/windows mirrors) | Shipped — built for this flip |
| Config injection (`__CADET_CONFIG__` via `cadet:config:get`) | all three preloads | Shipped |
| Platform forwards on the `app://` origin | `clients/*/src/main/index.ts` via `forwardPlatformRequest` | Shipped |
| Cloud artifactory for the app bundle (`/app/<version>`) | `services/cloud-api/app-artifacts.ts` (#277, #278) | Shipped |
| CLI edge app mode (shell at `/`, web iframed from `/web/assistant/`) | `cli/src/lib/nginx-ingress.ts` | Shipped — the reference self-hosted deployment of the same bundle |

## The hosting contract (per desktop shell)

1. **Renderer root → app dist.**
   - Packaged: `resources/app-dist` (macos/linux) / `resources/cli-runtime/app-dist`
     (windows keeps its layout) built from `@mycadet/app`'s standalone target.
   - Dev: the app Vite dev server (`clients/app`, port 5174) honored through
     `CADET_DEV_URL` — same mechanism as today's web dev server.
   - `RENDERER_MOUNT` moves from `/assistant` to `/` (the app bundle is root-based;
     asset URLs are `/assets/*`, no mount stripping needed).

2. **The assistant mount is the assistant's, not ours.**
   - Cloud assistants: `AssistantFrame` iframes `assistant.url` over https — the
     desktop CSP gains `frame-src` for Cadet assistant edges (`*.mycadet.ai` +
     self-hosted https edges), matching what the hub already allows.
   - Local assistants (lockfile `remote: "local"`): the frame targets the
     same-origin `app://mycadet.ai/assistant/...` path, which the protocol handler
     **proxies** to the active lockfile gateway (the existing
     `/assistant/__gateway/{port}/*` forward, lifted from "API paths only" to the
     whole mount). The web SPA keeps its `/assistant/` base, so asset URLs line up
     byte-for-byte with the proxied mount. The renderer never touches a bare
     `http://127.0.0.1` origin — the lockfile allowlist stays the security
     boundary.

3. **Bridge completion, not bridge invention.** The app package owns the contract;
   the desktop preload already satisfies it. Land any missing handler (e.g.
   `localMode.readLockfile` if a shell skipped it) in the shell's preload, typed by
   `@mycadet/ipc-contract`.

4. **Auth.** Desktop login flows through the native OAuth bridge
   (`startDesktopLogin` → `auth.startOAuth` → PKCE in main), which the app package
   already drives; the shell hands the session to the account client through the
   existing session-token store.

## Rollout

| Step | Scope | Notes |
| --- | --- | --- |
| 1. macOS flip (this PR) | `clients/macos`, `packages/electron-desktop` shared bits it uniquely consumes | Renderer root, mount, CSP `frame-src`, assistant-mount proxy, `build:app`/`dev:app` scripts, pack + electron-builder resources |
| 2. linux flip | `clients/linux` | Mechanical copy of step 1's diff shape; AppImage packaging |
| 3. windows flip | `clients/windows` | Same, plus `package-runtime.ts`/`package-smoke.ts` cli-runtime layout and the parity matrix |
| 4. Release plumbing | `.github/workflows/release.yml`, `dev-release.yaml`, `pr-macos/linux/windows.yaml` | Build/publish the app dist instead of web dist for electron jobs (web dist no longer needed at all — the assistant serves it) |
| 5. Cleanup | `clients/web` electron-isms, stale flags | Sweep only after all three shells flip |

## Explicitly out of scope

- The web shell keeps its current role: iframe content served from the assistant.
  Nothing in this flip adds desktop-only code to `clients/web`.
- Auto-update, tray, companion/popout windows, deep links — all unchanged; they
  orbit the main window whichever bundle it renders.
- The CLI edge (`nginx-ingress.ts`) — app mode there already works; the desktop
  proxies the assistant rather than serving a web dist, so no shared code changes.
