import { BrowserWindow, app, shell } from "electron";
import { z } from "zod";

import type { AppVersionInfo } from "@mycadet/ipc-contract";

import type { IpcHandle } from "./ipc";
import { createWindow } from "./windows";

export interface AboutRuntime {
  rendererBase: () => string;
  getAssistantName?: () => string | null;
  onAssistantNameChange?: (listener: () => void) => void;
}

export interface AboutIpc {
  handle: IpcHandle;
}

let runtime: AboutRuntime = {
  rendererBase: () => "app://mycadet.ai/assistant",
};

export const configureAboutRuntime = (next: AboutRuntime): void => {
  runtime = next;
};

/**
 * Branded About window — replaces Electron's default `aboutPanel`
 * (which only shows the bundle name) with the same information surface
 * Swift Cadet exposes today: app name, version, commit SHA, copyright,
 * link to the website.
 *
 * The UI itself is a React route in `clients/web` — `/assistant/about` —
 * loaded into a BrowserWindow by this module. Putting the UI in
 * `clients/web` keeps it inside the design system, lets it iterate
 * alongside the rest of the app, and stays in the dev contributor's
 * mental model that "UI lives in clients/web." Future auxiliary windows
 * (thread pop-outs, command palette, etc.) follow this same pattern;
 * this module is the working example.
 *
 * Version + commit SHA + copyright still flow from the host: the
 * renderer asks for them via `window.cadet.app.versionInfo()`, and
 * the IPC handler installed here returns them. `app.setAboutPanelOptions`
 * is also seeded so the native panel — which AppleScript and other
 * tooling can still invoke independently of our menu — carries the
 * right metadata.
 */

const WEBSITE = "https://mycadet.ai";

// Injected by `electron.vite.config.ts` at build time.
declare const __CADET_BUILD_SHA__: string;
declare const __CADET_ENVIRONMENT__: string;
declare const __CADET_VERSION_DISPLAY__: string;

const CADET_ENV: string =
  typeof __CADET_ENVIRONMENT__ === "string"
    ? __CADET_ENVIRONMENT__
    : "production";

const APP_NAME =
  CADET_ENV === "production"
    ? "Cadet"
    : `Cadet ${CADET_ENV.charAt(0).toUpperCase() + CADET_ENV.slice(1)}`;

// Local (dev) builds bake this shell's display version — the stamped form of
// its own package.json version (`<base>-local.<stamp>.<sha>`, see
// @mycadet/shared/local-version) — so the About panel names the build kind
// and the checkout it came from. Release builds bake the plain version.
const VERSION: string =
  typeof __CADET_VERSION_DISPLAY__ === "string" && __CADET_VERSION_DISPLAY__
    ? __CADET_VERSION_DISPLAY__
    : app.getVersion();

const COMMIT_SHA: string =
  typeof __CADET_BUILD_SHA__ === "string" ? __CADET_BUILD_SHA__ : "unknown";

const COPYRIGHT = (): string => `© ${new Date().getFullYear()} Vargas JR LLC`;

export type { AppVersionInfo };

export const getVersionInfo = (): AppVersionInfo => ({
  appName: APP_NAME,
  version: VERSION,
  commitSha: COMMIT_SHA,
  copyright: COPYRIGHT(),
  website: WEBSITE,
});

// The renderer route the About window loads. Mirrors `routes.about` in
// `clients/web/src/utils/routes.ts`; the literal is duplicated rather than
// imported because `clients/macos` and `clients/web` are separate TS projects.
// Drift surfaces as the About window loading the app's catch-all
// NotFound page.
const ABOUT_PATH = "/about";

const aboutWindowUrl = (): string => {
  return `${runtime.rendererBase()}${ABOUT_PATH}`;
};

// Module-scope handle so reopening the menu item focuses the existing
// window instead of stacking duplicates. Reset on `closed` so the next
// invocation rebuilds.
let aboutWindow: BrowserWindow | null = null;

export const openAboutWindow = (): void => {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }

  // `deny-all` navigation: the About window has no legitimate top-level
  // navigation — its only outbound link routes through
  // `window.cadet.app.openWebsite()` → `shell.openExternal` in main — so the
  // seam blocks every other path and every popup, keeping the
  // preload-exposed `window.cadet` surface from being carried somewhere we
  // don't control.
  aboutWindow = createWindow({
    browserWindow: {
      width: 360,
      height: 360,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const }
        : {}),
      title: `About ${APP_NAME}`,
      show: false,
    },
    navigation: "deny-all",
  });

  aboutWindow.once("ready-to-show", () => {
    aboutWindow?.show();
  });

  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });

  void aboutWindow.loadURL(aboutWindowUrl());
};

// Seed the native About panel — which AppleScript and other tooling can
// invoke independently of our menu. `applicationName` carries the active
// assistant's name (e.g. "Aria") when the renderer has published one,
// falling back to the brand name; everything else is build metadata.
const applyAboutPanelOptions = (): void => {
  app.setAboutPanelOptions({
    applicationName: runtime.getAssistantName?.() ?? APP_NAME,
    applicationVersion: VERSION,
    // The native panel renders `version` after an em-dash; the commit SHA
    // identifies the exact build.
    version: COMMIT_SHA,
    copyright: COPYRIGHT(),
    website: WEBSITE,
  });
};

let installed = false;
export const installAbout = ({ handle }: AboutIpc): void => {
  if (installed) {
    return;
  }
  installed = true;

  applyAboutPanelOptions();
  // Re-seed when the assistant name changes so the native panel tracks the
  // live identity.
  runtime.onAssistantNameChange?.(applyAboutPanelOptions);

  handle("cadet:app:versionInfo", z.tuple([]), () => getVersionInfo());

  // The renderer is sandboxed — `shell.openExternal` only works from
  // main. The About page's website-link click handler routes through
  // this IPC so the URL opens in the user's default browser instead
  // of navigating the About window away from its route. The target is
  // a fixed constant, never a renderer-supplied URL, so there's no
  // open-redirect surface here.
  handle("cadet:app:openWebsite", z.tuple([]), () =>
    shell.openExternal(WEBSITE),
  );
};
