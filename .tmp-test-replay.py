#!/usr/bin/env python3
"""The complete, idempotent test-file replay for the deep-exports sweep.

Restore clients' test files from HEAD first (`git checkout HEAD --` on the
*.test.ts set), then run this. Every operation is brace-balanced; nothing is
ever spliced by line arithmetic.
"""

import re
import subprocess

PKG = "@mycadet/electron-desktop"

KEEPS = {
    "about","app-logger","app-origin","auto-update","avatar","avatar-image",
    "bundle-flow","bundle-platform","capability-registry","command-palette-window",
    "commands","devtools","file-open","file-open-preload","floating-window",
    "notification-avatar-file","notification-avatar-path","notifications","preload",
    "session-token-store","settings","status","status-icon","tray-model",
    "window-attention","window-state","windows",
}

# ---------------------------------------------------------------- helpers

def find_matching(src, open_idx):
    depth = 0
    in_str = None
    i = open_idx
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == in_str and src[i - 1] != "\\":
                in_str = None
        elif ch in "\"'`":
            in_str = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unbalanced")

def mock_stmt_span(src, spec):
    marker = 'mock.module("' + spec + '"'
    i = src.find(marker)
    if i == -1:
        return None
    # The first brace after the marker is the factory's object literal; the
    # argument paren sits immediately before it (works for both the raw
    # `() => ({` shape and the converted `electronMock({` shape).
    b = src.index("{", i)
    open_paren = b - 1
    assert src[open_paren] == "(", src[open_paren - 10 : open_paren + 2]
    close = find_matching(src, open_paren)
    end = close + 1
    if src[end:end + 1] == ";":
        end += 1
    return (i, end)

def add_members(stmt, members):
    """Insert members missing from the statement's object literal."""
    body_open = stmt.index("{")
    body_close = find_matching(stmt, body_open)
    body = stmt[body_open + 1:body_close]
    missing = [m for m in members if m.split(":")[0].strip() not in body]
    if not missing:
        return stmt
    return (
        stmt[:body_open + 1]
        + "\n  "
        + "\n  ".join(missing)
        + stmt[body_open + 1:body_close + 1]
        + stmt[body_close + 1:]
    )

def add_app_members(stmt, members):
    """Add members to the `app: { ... }` member inside an electronMock call."""
    app_key = stmt.find("  app: {")
    if app_key == -1:
        return stmt
    open_brace = stmt.index("{", app_key)
    close_brace = find_matching(stmt, open_brace)
    body = stmt[open_brace + 1:close_brace]
    missing = [m for m in members if m.split(":")[0].strip() not in body]
    if not missing:
        return stmt
    return (
        stmt[:open_brace + 1]
        + "\n    "
        + "\n    ".join(missing)
        + stmt[open_brace + 1:close_brace + 1]
        + stmt[close_brace + 1:]
    )

# ---------------------------------------------------------------- data

APP_MEMBERS = ['getVersion: () => "0.0.0",', 'getName: () => "Cadet",', "isPackaged: false,"]

SEAM_STUBS = {
 "about": ['configureAboutRuntime: () => undefined,', 'getVersionInfo: () => ({ version: "0.0.0" }),', 'installAbout: () => undefined,', 'openAboutWindow: () => undefined,'],
 "app-logger": ['getLogFilePaths: () => [],'],
 "app-origin": ['createAllowedOriginResolver: () => () => ({ protocol: "app:", host: "mycadet.ai" }),', 'getAppName: () => "Cadet",', 'isAllowedOrigin: () => false,', 'resolveAllowedOrigin: () => ({ protocol: "app:", host: "mycadet.ai" }),'],
 "auto-update": ['checkForUpdates: () => undefined,', 'configureAutoUpdate: () => undefined,', 'installAutoUpdate: () => undefined,', 'resolveUpdateFeedUrl: () => "",'],
 "avatar": ['getAccentHex: () => "#000000",', 'getAvatarPng: () => Buffer.alloc(0),', 'getCharacter: () => undefined,', 'installAvatarIpc: () => undefined,', 'onAvatarChange: () => () => undefined,'],
 "avatar-image": ['avatarBitmap: () => Buffer.alloc(0),'],
 "bundle-flow": ['handleBundleFile: () => undefined,', 'installBundleFlow: () => undefined,'],
 "bundle-platform": ['BUNDLES_DIR_NAME: "bundles",', 'CADET_PROTOCOL: "cadet",', 'bundleFileHandlerToken: "bundleFileHandlerToken",', 'configureBundlePlatform: () => undefined,'],
 "command-palette-window": ['closeCommandPaletteWindow: () => undefined,', 'configureCommandPaletteWindow: () => undefined,', 'installCommandPaletteWindow: () => undefined,', 'isCommandPaletteWindowFocused: () => false,', 'openCommandPaletteWindow: () => undefined,', 'repositionCommandPaletteWindow: () => undefined,'],
 "commands": ['HOTKEY_SETTINGS: "hotkeys",', 'acceleratorOption: () => undefined,', 'configureHotkeySettings: () => undefined,', 'dispatchToFocused: () => undefined,', 'onHotkeyOverridesChange: () => () => undefined,'],
 "devtools": ['areChromeDevToolsEnabled: () => false,'],
 "file-open": ['configureFileOpen: () => undefined,', 'handleFileOpenArgv: () => undefined,', 'hasPendingFiles: () => false,', 'installFileOpen: () => undefined,', 'onFileOpen: () => () => undefined,'],
 "floating-window": ['configureFloatingWindows: () => undefined,', 'createFloatingWindow: () => undefined,', 'createWindowRouteResolver: () => () => ({ pathname: "/" }),', 'getFloatingWindow: () => undefined,'],
 "notification-avatar-file": ['ensureNotificationAvatarFile: () => "",'],
 "notification-avatar-path": ['resolveNotificationAvatarPath: () => undefined,'],
 "notifications": ['CATEGORY_ACTIONS: {},', 'NOTIFICATION_CATEGORIES: [],', 'configureNotifications: () => undefined,', 'createElectronNotification: () => undefined,', 'installNotifications: () => undefined,', 'isPreparedNotificationSenderCurrent: () => true,'],
 "session-token-store": ['clearSessionToken: () => undefined,', 'getSessionToken: () => null,', 'onSessionTokenChange: () => () => undefined,', 'saveSessionToken: () => undefined,', 'setSessionTokenLogger: () => undefined,'],
 "settings": ['onSettingChange: () => () => undefined,', 'readSetting: () => null,', 'writeSetting: () => undefined,'],
 "status": ['getStatus: () => undefined,', 'installConnectivityIpc: () => undefined,', 'installStatusIpc: () => undefined,', 'onStatusChange: () => () => undefined,', 'setBackendReachable: () => undefined,', 'shouldPulse: () => undefined,', 'setStatus: () => undefined,', 'getConnectivity: () => undefined,', 'setConnectivity: () => undefined,', 'setDeviceOnline: () => undefined,', 'onConnectivityChange: () => () => undefined,', 'statusMenuTitle: () => "Status",', 'PULSE_FRAME_COUNT: 12,', 'PULSE_FRAME_INTERVAL_MS: 60,', 'PULSE_MIN_OPACITY: 0.4,', 'PULSE_MAX_OPACITY: 1,'],
 "status-icon": ['configureStatusIconFallback: () => undefined,'],
 "tray-model": ['configureTrayModel: () => undefined,', 'installTray: () => undefined,'],
 "window-attention": ['installWindowAttention: () => undefined,'],
 "window-state": ['clearCompanionIntroSeen: () => undefined,', 'onCompanionHiddenChange: () => () => undefined,', 'readCompanionCallDock: () => undefined,', 'readCompanionHidden: () => false,', 'readCompanionIntroSeenVersion: () => undefined,', 'readCompanionSize: () => undefined,', 'readTitleBarOverlayTheme: () => undefined,', 'restoreBounds: () => undefined,', 'track: () => undefined,', 'writeCompanionCallDock: () => undefined,', 'writeCompanionHidden: () => undefined,', 'writeCompanionIntroSeen: () => undefined,', 'writeCompanionSize: () => undefined,', 'writeOnboardingActive: () => undefined,', 'writeTitleBarOverlayTheme: () => undefined,'],
 "windows": ['createWindow: () => undefined,', 'hardenedWebPreferences: () => ({}),', 'installWebContentsSecurity: () => undefined,'],
}

# ---------------------------------------------------------------- main

files = subprocess.run(["git", "ls-files", "clients"], capture_output=True, text=True).stdout.split()
touched = 0
for f in files:
    if not f.endswith(".test.ts"):
        continue
    src = open(f).read()
    orig = src

    # 1) deleted client shims -> package seams
    src = src.replace('mock.module("./windows.client"', 'mock.module("' + PKG + '/windows"')
    src = src.replace('mock.module("./logger"', 'mock.module("' + PKG + '/app-logger"')

    # 2) removed deep-entry imports -> the root specifier (whole-file swap;
    #    import statements and mock targets alike)
    spec_re = re.compile('"' + re.escape(PKG) + r'/([a-z0-9/.\-]+)"')
    src = spec_re.sub(lambda m: m.group(0) if m.group(1) in KEEPS else '"' + PKG + '"', src)

    # 3) seam-mock surface completion
    for mod, stubs in SEAM_STUBS.items():
        span = mock_stmt_span(src, PKG + "/" + mod)
        if span is None:
            continue
        s, e = span
        stmt = src[s:e]
        new_stmt = add_members(stmt, stubs)
        if new_stmt != stmt:
            src = src[:s] + new_stmt + src[e:]

    # 4) in-file electron mocks -> electronMock overrides (one-word insert)
    marker = 'mock.module("electron", () => ({'
    if marker in src:
        rel = ("../" * (len(f.split("/")) - 3)) + "test-setup"
        s, e = mock_stmt_span(src, "electron")
        stmt = src[s:e]
        new_stmt = stmt.replace("() => ({", "() => electronMock({", 1)
        src = src[:s] + new_stmt + src[e:]
        if "electronMock" not in src.split('mock.module("electron"')[0]:
            src = src.replace('from "bun:test";\n', 'from "bun:test";\nimport { electronMock } from "' + rel + '";\n', 1)
        # 5) the graph's common app members for partial overrides
        s2, e2 = mock_stmt_span(src, "electron")
        stmt2 = src[s2:e2]
        new_stmt2 = add_app_members(stmt2, APP_MEMBERS)
        if new_stmt2 != stmt2:
            src = src[:s2] + new_stmt2 + src[e2:]

    # 6) router's __testing seam
    if "host-proxy-feature" in f:
        src = src.replace(
            'const { __testing } =\n  await import("' + PKG + '");',
            'const { routerTesting } = await import("' + PKG + '");')
        src = src.replace(
            'const { __testing } =\n  await import("' + PKG + '/host-proxy/router");',
            'const { routerTesting } = await import("' + PKG + '");')
        src = re.sub(r"\b__testing\.(reset|executors|connections)", r"routerTesting.\1", src)

    # 7) auto-update tests: the feed-url helper is private now
    if f.endswith("auto-update.test.ts"):
        src = src.replace('import { resolveUpdateFeedUrl } from "' + PKG + '/auto-update";\n', "")
        src = re.sub(r'const \{ installAutoUpdate, \w+UpdateFeedUrl \} =\n?\s*await import\("\./auto-update"\);', 'const { installAutoUpdate } = await import("./auto-update");', src)
        m = re.search(r'describe\("\w+UpdateFeedUrl".*?(?=describe\("installAutoUpdate")', src, re.S)
        if m:
            src = src[:m.start()] + src[m.end():]
        m = re.search(r'describe\("resolveUpdateFeedUrl".*?(?=describe\("installAutoUpdate")', src, re.S)
        if m:
            src = src[:m.start()] + src[m.end():]

    if src != orig:
        open(f, "w").write(src)
        touched += 1

print("files touched:", touched)
