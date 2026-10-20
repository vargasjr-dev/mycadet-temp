#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(ROOT_DIR, "..", "..");

// Bun hoists workspace deps into the repo-root node_modules, so `electron`
// may resolve from either home. Pick the first install that actually shipped
// the app bundle — a silent skip would leave the stock "Electron" identity
// (and old stamp) on the binary electron-vite launches.
const ELECTRON_DIST_DIR = [
  path.join(ROOT_DIR, "node_modules", "electron", "dist"),
  path.join(REPO_ROOT, "node_modules", "electron", "dist"),
].find((dir) => existsSync(path.join(dir, "Electron.app")));
const ELECTRON_APP = path.join(ELECTRON_DIST_DIR ?? "", "Electron.app");
const ELECTRON_INFO_PLIST = path.join(ELECTRON_APP, "Contents", "Info.plist");

// Sentinel marking that we've restarted the Dock for this patched bundle.
// Lives in `dist/` but OUTSIDE `Electron.app/` so it doesn't disturb the
// bundle's code signature. Wiped when `electron` is reinstalled (which resets
// the plist to stock "Electron"), so the next prepare re-busts the Dock.
const DOCK_BUST_MARKER = ELECTRON_DIST_DIR
  ? path.join(ELECTRON_DIST_DIR, ".cadet-dock-busted")
  : null;

// macOS keys notification authorization to the bundle identifier. The stock
// Electron.app ships as `com.github.Electron` — an identifier shared by every
// Electron app on the machine, which routinely lands in a denied state and
// makes `new Notification().show()` fail with `UNErrorDomain error 1`
// (notificationsNotAllowed). Stamp our own owned identifier so the dev app
// gets a clean authorization prompt. The env rides as a subdomain of the
// packaged prod id (`ai.mycadet.electron.<env>`); prod itself carries no
// subdomain prefix (electron-builder.config.cjs).
const CADET_ENVIRONMENT = process.env.CADET_ENVIRONMENT || "local";
const DEV_BUNDLE_ID =
  CADET_ENVIRONMENT === "production"
    ? "ai.mycadet.electron"
    : `ai.mycadet.electron.${CADET_ENVIRONMENT}`;

// Same env→name scheme as electron-builder.config.cjs's productName, so the
// dev menu bar / Dock label reads "Cadet Local" (etc.) the way a packaged
// build of the same environment does. `app.setName` in src/main/index.ts
// stays "Cadet Electron" on purpose: the dev userData dir keeps its
// separation from packaged installs of every environment.
const DEV_APP_NAME =
  CADET_ENVIRONMENT === "production"
    ? "Cadet"
    : `Cadet ${CADET_ENVIRONMENT.charAt(0).toUpperCase()}${CADET_ENVIRONMENT.slice(1)}`;

const REQUIRED_PLIST_STRINGS: Record<string, string> = {
  CFBundleDisplayName: DEV_APP_NAME,
  CFBundleName: DEV_APP_NAME,
  CFBundleIdentifier: DEV_BUNDLE_ID,
  NSUserNotificationAlertStyle: "alert",
};

const plistBuddy = (args: string[]): string =>
  execFileSync("/usr/libexec/PlistBuddy", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const readPlistString = (key: string): string | null => {
  try {
    return plistBuddy(["-c", `Print :${key}`, ELECTRON_INFO_PLIST]);
  } catch {
    return null;
  }
};

const setPlistString = (key: string, value: string): boolean => {
  if (readPlistString(key) === value) return false;
  try {
    plistBuddy(["-c", `Set :${key} ${value}`, ELECTRON_INFO_PLIST]);
  } catch {
    plistBuddy(["-c", `Add :${key} string ${value}`, ELECTRON_INFO_PLIST]);
  }
  return true;
};

const isValidSignature = (): boolean => {
  try {
    execFileSync(
      "codesign",
      ["--verify", "--deep", "--strict", "--verbose=1", ELECTRON_APP],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
};

if (process.platform !== "darwin") {
  process.exit(0);
}

if (!ELECTRON_DIST_DIR || !existsSync(ELECTRON_INFO_PLIST)) {
  console.warn(
    `[prepare-electron-dev-app] Electron.app Info.plist not found at ${ELECTRON_INFO_PLIST}; skipping`,
  );
  process.exit(0);
}

let changed = false;
for (const [key, value] of Object.entries(REQUIRED_PLIST_STRINGS)) {
  changed = setPlistString(key, value) || changed;
}

// Notification prompts show the bundle's icon; the stock Electron.app ships
// none of ours. Copy the same icns electron-builder packages (mac.icon) and
// point CFBundleIconFile at it — the copy invalidates the signature, so this
// rides the re-sign below.
const ICON_SOURCE = path.join(ROOT_DIR, "build", "icon.icns");
const ICON_NAME = "cadet-dev";
if (existsSync(ICON_SOURCE)) {
  try {
    copyFileSync(
      ICON_SOURCE,
      path.join(ELECTRON_APP, "Contents", "Resources", `${ICON_NAME}.icns`),
    );
    changed = setPlistString("CFBundleIconFile", ICON_NAME) || changed;
  } catch (error) {
    console.warn(
      "[prepare-electron-dev-app] icon stamp failed (continuing):",
      error instanceof Error ? error.message : error,
    );
  }
}

if (changed || !isValidSignature()) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", ELECTRON_APP], {
    stdio: "inherit",
  });

  // Re-register the (re-signed) bundle with Launch Services so macOS picks up
  // the new identifier — without this the first `.show()` may not surface an
  // authorization prompt and the app won't appear under
  // System Settings → Notifications. Best-effort: never block the dev flow.
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  try {
    execFileSync(lsregister, ["-f", ELECTRON_APP], { stdio: "inherit" });
  } catch (error) {
    console.warn(
      "[prepare-electron-dev-app] lsregister failed (continuing):",
      error instanceof Error ? error.message : error,
    );
  }
}

// The Dock and Cmd-Tab read a bundle's label from `CFBundleName`, cached by
// macOS keyed to the bundle path. The `lsregister -f` above re-registers the
// bundle but does NOT evict the running Dock's in-memory label, so a bundle
// first seen as the stock "Electron" keeps showing "Electron" even after its
// plist is stamped to "Cadet Electron". Restarting the Dock forces it to
// re-read the name. Done once per patched bundle (tracked by the marker, and
// again whenever the plist actually changes) so routine `bun run dev` restarts
// don't blink the Dock on every launch. Best-effort — never block the dev flow.
if (DOCK_BUST_MARKER && (changed || !existsSync(DOCK_BUST_MARKER))) {
  try {
    execFileSync("killall", ["Dock"], { stdio: "ignore" });
    writeFileSync(DOCK_BUST_MARKER, "");
  } catch {
    // Dock not running, or `killall` unavailable — leave the marker absent so
    // a later run retries.
  }
}

console.log("[prepare-electron-dev-app] Electron.app is ready");
