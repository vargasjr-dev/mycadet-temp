/**
 * @mycadet/electron-desktop - the desktop clients' shared package.
 *
 * The root index is the package's public surface: exactly the bindings
 * the desktop clients (and the CLI) consume, each exported from its
 * defining module. Modules not listed here are implementation detail —
 * reachable only within the package — which keeps the surface auditable
 * and the preload bundles lean.
 */
export {
  configureAboutRuntime,
  getVersionInfo,
  installAbout,
  openAboutWindow,
} from "./about";
export {
  APP_HOST,
  APP_PROTOCOL,
  APP_RENDERER_BASE_PROD,
  RENDERER_BASE_PROD,
  getDevRendererBase,
  getRendererBase,
  getRendererRootUrl,
  usesAppProtocolRenderer,
} from "./app-config";
export { startApp } from "./app-lifecycle";
export { default as log, getLogFilePaths } from "./app-logger";
export {
  createAllowedOriginResolver,
  getAppName,
  isAllowedOrigin,
  resolveAllowedOrigin,
} from "./app-origin";
export type { AllowedOrigin } from "./app-origin";
export { registerAppProtocol } from "./app-protocol-forward";
export {
  getAccentHex,
  getAvatarPng,
  getCharacter,
  installAvatarIpc,
  onAvatarChange,
} from "./avatar";
export { avatarBitmap } from "./avatar-image";
export { handleBundleFile, installBundleFlow } from "./bundle-flow";
export { createBundleHostProvider } from "./bundle-host";
export {
  BUNDLES_DIR_NAME,
  CADET_PROTOCOL,
  bundleFileHandlerToken,
  configureBundlePlatform,
} from "./bundle-platform";
export { registerCadetProtocol } from "./cadet-protocol";
export {
  BridgeCapabilityRegistry,
  DesktopCapabilityRegistry,
  capabilityToken,
  installCapabilityModules,
} from "./capability-registry";
export type {
  CapabilityModule,
  CapabilityModuleExport,
  MainWindowController,
} from "./capability-registry";
export {
  closeCommandPaletteWindow,
  configureCommandPaletteWindow,
  installCommandPaletteWindow,
  isCommandPaletteWindowFocused,
  openCommandPaletteWindow,
  repositionCommandPaletteWindow,
} from "./command-palette-window";
export {
  HOTKEY_SETTINGS,
  acceleratorOption,
  configureHotkeySettings,
  dispatchToFocused,
  onHotkeyOverridesChange,
} from "./commands";
export type { CadetCommand, HotkeySettingsProvider } from "./commands";
export {
  companionSizeSubmenus,
  companionVisibilityItem,
} from "./companion-menu";
export { installConnectivityProbe } from "./connectivity-probe";
export { installCsp } from "./csp";
export {
  DEEP_LINK_PROTOCOL_REGISTRATION,
  configureDeepLinks,
  hasPendingDeepLinks,
  installDeepLinks,
  resolveAuthCallbackScheme,
  resolveRegisteredSchemes,
} from "./deep-links";
export { getDeviceId } from "./device-id";
export { areChromeDevToolsEnabled } from "./devtools";
export { installDiagnosticsIpc } from "./diagnostics";
export { createDictationEscapeMonitor } from "./dictation-escape-monitor";
export {
  DICTATION_OVERLAY_ALWAYS_ON_TOP_LEVEL,
  DONE_HIDE_MS,
  ERROR_HIDE_MS,
  configureDictationOverlayWindow,
  createDictationOverlayController,
  installDictationOverlay,
  positionDictationOverlayInWorkArea,
  repositionDictationOverlayWindow,
} from "./dictation-overlay-window";
export type { DictationOverlayState } from "./dictation-overlay-window";
export {
  DICTATION_PUSH_SAMPLE_RATE,
  DictationOwnerRouter,
  dictationPartialsHelperResultSchema,
  requestDictationTranscription,
  toAudioBuffer,
} from "./dictation-routing";
export { installDownloads } from "./downloads";
export { configureFeedback, installFeedbackIpc } from "./feedback";
export type { FeedbackDependencies } from "./feedback";
export {
  configureFileOpen,
  handleFileOpenArgv,
  hasPendingFiles,
  installFileOpen,
  onFileOpen,
} from "./file-open";
export { createFileOpenPreloadBridge } from "./file-open-preload";
export {
  configureFloatingWindows,
  createFloatingWindow,
  createWindowRouteResolver,
  getFloatingWindow,
} from "./floating-window";
export { installGatewayRequestGuard } from "./gateway-request-guard";
export { installGlobalShortcuts } from "./global-shortcuts";
export { buildHelperToastRequest } from "./helper-toast-request";
export { createCuHelperProxyExecutor } from "./host-proxy/cu-executor";
export { HostBrowserExecutor } from "./host-proxy/executors/host-browser-executor";
export { hostFileExecutor } from "./host-proxy/executors/host-file-executor";
export {
  __testing,
  createHostShellExecutor,
} from "./host-proxy/executors/host-shell-executor";
export type { HostShellSpec } from "./host-proxy/executors/host-shell-executor";
export { __testing as routerTesting } from "./host-proxy/router";
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
export { installHotkeysIpc } from "./hotkeys";
export { getName, installIdentityIpc, onNameChange, setName } from "./identity";
export { installImageContextMenu } from "./image-context-menu";
export {
  applyAlphaMask,
  compositeCentered,
  roundedRectCoverage,
} from "./image-mask";
export { createIpcRegistrar } from "./ipc";
export type { IpcHandle } from "./ipc";
export {
  STARTUP_REGISTRATION,
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "./login-item";
export {
  buildDesktopMenu,
  conversationFileMenuItems,
  editMenu,
  editMenuItems,
  fileMenu,
  helpMenu,
  historyNavigationMenuItems,
  installDesktopMenu,
  setDesktopHasCloudSession,
  viewMenu,
  viewMenuItems,
  windowMenu,
} from "./menu";
export { configureNativeAuth, installNativeAuth } from "./native-auth";
export type { NativeAuthCallback } from "./native-auth";
export { resolveNotificationAvatarPath } from "./notification-avatar-path";
export {
  CATEGORY_ACTIONS,
  NOTIFICATION_CATEGORIES,
  configureNotifications,
  createElectronNotification,
  installNotifications,
  isPreparedNotificationSenderCurrent,
} from "./notifications";
export type {
  CategoryAction,
  NotificationCreateOptions,
  NotificationLike,
} from "./notifications";
export { installPermissionHandler } from "./permissions";
export { configurePopoutWindows, installPopoutWindows } from "./popout-window";
export { installPowerEvents } from "./power-events";
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
export { configurePresenceRuntime } from "./presence-runtime";
export {
  configureQuickInputWindow,
  installQuickInput,
  repositionQuickInputWindow,
  toggleQuickInput,
} from "./quick-input-window";
export {
  clearSessionToken,
  getSessionToken,
  onSessionTokenChange,
  saveSessionToken,
  setSessionTokenLogger,
} from "./session-token-store";
export { onSettingChange, readSetting, writeSetting } from "./settings";
export {
  getStatus,
  installConnectivityIpc,
  installStatusIpc,
  onStatusChange,
} from "./status";
export { configureStatusIconFallback } from "./status-icon";
export { installTextContextMenu } from "./text-context-menu";
export { configureTrayModel, installTray } from "./tray-model";
export type { TrayHandlers, TrayMenuIcon } from "./tray-model";
export { installWindowAttention } from "./window-attention";
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
export {
  createWindow,
  hardenedWebPreferences,
  installWebContentsSecurity,
} from "./windows";
export type { CreateWindowOptions } from "./windows";
