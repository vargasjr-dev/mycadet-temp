import { contextBridge } from "electron";

import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  ConnectivityState,
  CadetBridge,
  CadetCommand,
  DeepLink,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  LocalAssistantStatusResult,
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
} from "@mycadet/ipc-contract";

import { composeDesktopPreload } from "@mycadet/electron-desktop/preload";
import { createMacosCoreBridge } from "./core-capabilities";
import { install as installHelperHotkeys } from "./features/helper-hotkeys";
import { install as installPermissionsSetup } from "./features/permissions-setup";
import { install as installVoiceActivity } from "./features/voice-activity";

export type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  ConnectivityState,
  DeepLink,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  LocalAssistantStatusResult,
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  CadetBridge,
  CadetCommand,
};

// The client's core bridge, the shared feature set, and the macOS-only
// features: the helper's raw-keyboard hotkey flavor, the permission-setup
// guide, and the voice-activity surface. The global `Window.cadet` view is
// the shared preload entry's, not this file's.
const bridge = composeDesktopPreload(createMacosCoreBridge(), [
  installHelperHotkeys,
  installPermissionsSetup,
  installVoiceActivity,
]);
contextBridge.exposeInMainWorld("cadet", bridge);
