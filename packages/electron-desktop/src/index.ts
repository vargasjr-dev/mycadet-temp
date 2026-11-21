/**
 * @mycadet/electron-desktop - the desktop clients' shared package.
 *
 * The root index is the package's public surface: exactly the bindings
 * the desktop clients (and the CLI) consume, each exported from its
 * defining module. Modules not listed here are implementation detail —
 * reachable only within the package — which keeps the surface auditable
 * and the preload bundles lean.
 */
export { getVersionInfo, openAboutWindow } from "./about";
export {
  APP_HOST,
  APP_PROTOCOL,
  APP_RENDERER_BASE_PROD,
  RENDERER_BASE_PROD,
} from "./app-config";
export { startApp } from "./app-lifecycle";
export {
  configureMainWindow,
  current as currentMainWindow,
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
  hide as hideMainWindow,
  installMainWindow,
  onMainWindowVisibilityChange,
  setOnboarding as setMainWindowOnboarding,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
export {
  CLI_RUNTIME_ENTRIES,
  readRuntimeManifest,
} from "./win32-cli/cli-installer";
export {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "./win32-cli/cli-launcher";
export { registerCompanionSurfaceSync } from "./companion-menu";
export { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin";
export { getAppName } from "./app-name";
export type { AllowedOrigin } from "./app-origin";
export {
  getAccentHex,
  getAvatarPng,
  getCharacter,
  installAvatarIpc,
  onAvatarChange,
} from "./avatar";
export { avatarBitmap } from "./avatar-image";
export { createBundleHostProvider } from "./bundle-host";
export { BUNDLES_DIR_NAME, configureBundlePlatform } from "./bundle-platform";
export { BridgeCapabilityRegistry } from "./capability-registry";
export { acceleratorOption, dispatchToFocused } from "./commands";
export type { CadetCommand, HotkeySettingsProvider } from "./commands";
export { companionSizeSubmenus } from "./companion-menu";
export { hasPendingDeepLinks } from "./deep-links";
export { getDeviceId } from "./device-id";
export { areChromeDevToolsEnabled } from "./devtools";
export { createDictationEscapeMonitor } from "./dictation-escape-monitor";
export {
  DICTATION_OVERLAY_ALWAYS_ON_TOP_LEVEL,
  DONE_HIDE_MS,
  ERROR_HIDE_MS,
  configureDictationOverlayWindow,
  createDictationOverlayController,
  installDictationOverlay,
  positionDictationOverlayInWorkArea,
} from "./dictation-overlay-window";
export type { DictationOverlayState } from "./dictation-overlay-window";
export {
  DICTATION_PUSH_SAMPLE_RATE,
  DictationOwnerRouter,
  dictationPartialsHelperResultSchema,
  requestDictationTranscription,
  toAudioBuffer,
} from "./dictation-routing";
export { configureFeedback } from "./feedback";
export type { FeedbackDependencies } from "./feedback";
export { hasPendingFiles } from "./file-open";
export { createFileOpenPreloadBridge } from "./file-open-preload";
export {
  configureFloatingWindows,
  createFloatingWindow,
  createWindowRouteResolver,
  getFloatingWindow,
} from "./floating-window";
export { installGlobalShortcuts } from "./global-shortcuts";
export { createCuHelperProxyExecutor } from "./host-proxy/cu-executor";
export { HostBrowserExecutor } from "./host-proxy/executors/host-browser-executor";
export { hostFileExecutor } from "./host-proxy/executors/host-file-executor";
export { createHostShellExecutor } from "./host-proxy/executors/host-shell-executor";
export type { HostShellSpec } from "./host-proxy/executors/host-shell-executor";
export { hostTransferExecutor } from "./host-proxy/executors/host-transfer-executor";
export { createHostUiSnapshotExecutor } from "./host-proxy/executors/host-ui-snapshot-executor";
export type { CuHelperClient } from "./host-proxy/helper-proxy-executor";
export { HostProxyPoster } from "./host-proxy/poster";
export type { HostCuResultPayload } from "./host-proxy/poster";
export {
  createHostProxyClientHeaders,
  installHostProxyBridge,
} from "./host-proxy/router";
export type { HostProxyExecutor, HostProxyRuntime } from "./host-proxy/router";
export { createHostProxyRuntime } from "./host-proxy/runtime";
export type { HostProxySseMessage } from "./host-proxy/sse";
export { getName, onNameChange, setName } from "./identity";
export {
  applyAlphaMask,
  compositeCentered,
  roundedRectCoverage,
} from "./image-mask";
export type { IpcHandle } from "./ipc";
export {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "./login-item";
export { configureNativeAuth, installNativeAuth } from "./native-auth";
export type { NativeAuthCallback } from "./native-auth";
export { resolveNotificationAvatarPath } from "./notification-avatar-path";
export {
  CATEGORY_ACTIONS,
  NOTIFICATION_CATEGORIES,
  createElectronNotification,
  isPreparedNotificationSenderCurrent,
} from "./notifications";
export type {
  CategoryAction,
  NotificationCreateOptions,
  NotificationLike,
} from "./notifications";
export { configurePopoutWindows } from "./popout-window";
export {
  createBundleConfirmBridge,
  createDeepLinksBridge,
  createDictationOfferBridge,
  createDownloadsBridge,
  createHotkeysBridge,
  createLaunchAtLoginBridge,
  createNotificationsBridge,
  createPermissionSetupBridge,
  createUpdateBridge,
} from "./preload";
export { configureQuickInputWindow } from "./quick-input-window";
export {
  clearSessionToken,
  getSessionToken,
  onSessionTokenChange,
  saveSessionToken,
} from "./session-token-store";
export { onSettingChange, readSetting, writeSetting } from "./settings";
export { getStatus } from "./status";
export { configureTrayModel, installTray } from "./tray-model";
export type { TrayHandlers, TrayMenuIcon } from "./tray-model";
export { createWindowReadiness } from "./window-readiness";
export {
  clearCompanionIntroSeen,
  onCompanionHiddenChange,
  readCompanionCallDock,
  readCompanionHidden,
  readCompanionIntroSeenVersion,
  readCompanionSize,
  readOnboardingActive,
  readTitleBarOverlayTheme,
  restoreBounds,
  track,
  writeCompanionCallDock,
  writeCompanionHidden,
  writeCompanionIntroSeen,
  writeCompanionSize,
  writeOnboardingActive,
  writeTitleBarOverlayTheme,
} from "./window-state";
export { createWindow, hardenedWebPreferences } from "./windows";
export type { CreateWindowOptions } from "./windows";
