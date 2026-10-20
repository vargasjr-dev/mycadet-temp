import { createPermissionSetupBridge } from "@mycadet/electron-desktop/preload";
import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";

import { createLocalModeBridge } from "@mycadet/electron-desktop/local-mode-bridge";
import { createFileOpenPreloadBridge } from "@mycadet/electron-desktop/file-open-preload";

import type { Lockfile, LockfileWriteResult } from "@mycadet/local-mode";
import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  CompanionAnnotationPhase,
  CompanionAnnotationStroke,
  CompanionAnnotationTool,
  CompanionCoachmark,
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionContext,
  ScreenCaptureFrame,
  ShareTargetSnapshot,
  WatchCaptureTarget,
  CompanionIntroAction,
  CompanionIntroAnnouncementAction,
  CompanionIntroCallControl,
  CompanionIntroReport,
  CompanionSurfaceState,
  ConnectivityState,
  DeepLink,
  DictationOverlayHitRegion,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationOfferAnswer,
  CompanionPopoverAnswer,
  CompanionPopoverView,
  CompanionPicker,
  DictationPartialsResult,
  DictationTranscribeResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeySelectionResult,
  ChordBinding,
  ChordRegistrationResult,
  ModifierHold,
  ModifierHoldRegistrationResult,
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
  VoiceActivityContent,
  VoiceActivityControl,
  VoiceActivityStart,
} from "@mycadet/ipc-contract";
import {
  DIAGNOSTICS_SET_SHARE,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_APPS_FRONTMOST,
  HELPER_APPS_QUIT,
  HELPER_APPS_RUNNING,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_HOTKEY_READ_FRONT_SELECTION,
  HELPER_HOTKEY_SET_CHORDS,
  HELPER_HOTKEY_SET_MODIFIER_HOLD,
  HELPER_INPUT_ACTIVITY_EVENT,
  HELPER_INPUT_SET_ACTIVITY_WATCH,
} from "@mycadet/ipc-contract";
import {
  createBundleConfirmBridge,
  createDeepLinksBridge,
  createDictationOfferBridge,
  createDownloadsBridge,
  createHotkeysBridge,
  createLaunchAtLoginBridge,
  createNotificationsBridge,
  createUpdateBridge,
} from "@mycadet/electron-desktop/preload";

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

const notImplemented = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`window.cadet.${name} is not implemented yet`));

const subscribeDictationEvent =
  (channel: string) =>
  (callback: (event: DictationPartialEvent) => void): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: DictationPartialEvent,
    ) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  };

const fileOpenBridge = createFileOpenPreloadBridge({ ipcRenderer, webUtils });

const bridge: CadetBridge = {
  platform: "electron",
  hostOS: "macos",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("cadet:app:versionInfo") as Promise<AppVersionInfo>,
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("cadet:app:openWebsite") as Promise<void>,
  },
  text: {
    insertIntoFrontApp: (text: string): Promise<TextInsertionResult> =>
      ipcRenderer.invoke(
        "cadet:text:insertIntoFrontApp",
        text,
      ) as Promise<TextInsertionResult>,
    openAutomationSettings: (): Promise<void> =>
      ipcRenderer.invoke("cadet:text:openAutomationSettings") as Promise<void>,
    undoInFrontApp: (): Promise<TextInsertionResult> =>
      ipcRenderer.invoke(
        "cadet:text:undoInFrontApp",
      ) as Promise<TextInsertionResult>,
  },
  auth: {
    startOAuth: (options: {
      loginHint?: string;
      intent?: string;
    }): Promise<{ sessionToken: string }> =>
      ipcRenderer.invoke("cadet:auth:startOAuth", options) as Promise<{
        sessionToken: string;
      }>,
    cancelOAuth: (): Promise<void> =>
      ipcRenderer.invoke("cadet:auth:cancelOAuth") as Promise<void>,
    getSessionToken: (): string | null =>
      ipcRenderer.sendSync("cadet:auth:getSessionToken") as string | null,
    signOut: (): Promise<void> =>
      ipcRenderer.invoke("cadet:auth:signOut") as Promise<void>,
  },
  hotkeys: createHotkeysBridge(ipcRenderer),
  launchAtLogin: createLaunchAtLoginBridge(ipcRenderer),
  diagnostics: {
    setShareDiagnostics: (enabled: boolean): void => {
      ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
    },
  },
  helper: {
    ping: () => ipcRenderer.invoke("cadet:helper:ping") as Promise<"pong">,
    getState: () =>
      ipcRenderer.invoke("cadet:helper:state:get") as Promise<HelperState>,
    restart: () =>
      ipcRenderer.invoke(
        "cadet:helper:restart",
      ) as Promise<HelperRestartResult>,
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: HelperState) => {
        callback(payload);
      };
      ipcRenderer.on("cadet:helper:state", handler);
      return () => {
        ipcRenderer.off("cadet:helper:state", handler);
      };
    },
    hotkey: {
      setModifierHold: (
        hold: ModifierHold,
      ): Promise<ModifierHoldRegistrationResult> =>
        ipcRenderer.invoke(
          HELPER_HOTKEY_SET_MODIFIER_HOLD,
          hold,
        ) as Promise<ModifierHoldRegistrationResult>,
      setChords: (binding: ChordBinding): Promise<ChordRegistrationResult> =>
        ipcRenderer.invoke(
          HELPER_HOTKEY_SET_CHORDS,
          binding,
        ) as Promise<ChordRegistrationResult>,
      readFrontSelection: (): Promise<HotkeySelectionResult> =>
        ipcRenderer.invoke(
          HELPER_HOTKEY_READ_FRONT_SELECTION,
        ) as Promise<HotkeySelectionResult>,
      onEvent: (callback) => {
        const handler = (_event: IpcRendererEvent, payload: HotkeyEvent) => {
          callback(payload);
        };
        ipcRenderer.on("cadet:helper:hotkey:event", handler);
        return () => {
          ipcRenderer.off("cadet:helper:hotkey:event", handler);
        };
      },
    },
    apps: {
      running: (bundleIds: readonly string[]): Promise<string[]> =>
        ipcRenderer.invoke(HELPER_APPS_RUNNING, [...bundleIds]) as Promise<
          string[]
        >,
      quit: (bundleId: string): Promise<boolean> =>
        ipcRenderer.invoke(HELPER_APPS_QUIT, bundleId) as Promise<boolean>,
      frontmost: (): Promise<string | null> =>
        ipcRenderer.invoke(HELPER_APPS_FRONTMOST) as Promise<string | null>,
    },
    input: {
      setActivityWatch: (enable: boolean): Promise<boolean> =>
        ipcRenderer.invoke(
          HELPER_INPUT_SET_ACTIVITY_WATCH,
          enable,
        ) as Promise<boolean>,
      onActivity: (callback: () => void): (() => void) => {
        const handler = () => {
          callback();
        };
        ipcRenderer.on(HELPER_INPUT_ACTIVITY_EVENT, handler);
        return () => {
          ipcRenderer.off(HELPER_INPUT_ACTIVITY_EVENT, handler);
        };
      },
    },
    dictation: {
      setPartials: (
        enable: boolean,
        deviceName?: string,
        pushAudio?: boolean,
      ): Promise<DictationPartialsResult> =>
        ipcRenderer.invoke(
          HELPER_DICTATION_SET_PARTIALS,
          enable,
          deviceName,
          pushAudio,
        ) as Promise<DictationPartialsResult>,
      pushAudioChunk: (chunk: ArrayBuffer): void => {
        ipcRenderer.send("cadet:helper:dictation:audio", chunk);
      },
      onPartial: subscribeDictationEvent(HELPER_DICTATION_PARTIAL_EVENT),
      onFinalized: subscribeDictationEvent(HELPER_DICTATION_FINALIZED_EVENT),
      transcribe: (audio: ArrayBuffer): Promise<DictationTranscribeResult> =>
        ipcRenderer.invoke(
          HELPER_DICTATION_TRANSCRIBE,
          audio,
        ) as Promise<DictationTranscribeResult>,
      onTranscribed: subscribeDictationEvent(
        HELPER_DICTATION_TRANSCRIBED_EVENT,
      ),
    },
  },
  permissions: {
    setup: createPermissionSetupBridge(ipcRenderer),
    getState: (): Promise<SystemPermissionsState> =>
      ipcRenderer.invoke(
        "cadet:permissions:getState",
      ) as Promise<SystemPermissionsState>,
    request: (
      kind: SystemPermissionKind,
      presentation?: Parameters<CadetBridge["permissions"]["request"]>[1],
    ): Promise<SystemPermissionStateItem> =>
      (presentation
        ? ipcRenderer.invoke("cadet:permissions:request", kind, presentation)
        : ipcRenderer.invoke(
            "cadet:permissions:request",
            kind,
          )) as Promise<SystemPermissionStateItem>,
    openSettings: (
      kind: SystemPermissionKind,
    ): Promise<SystemPermissionStateItem> =>
      ipcRenderer.invoke(
        "cadet:permissions:openSettings",
        kind,
      ) as Promise<SystemPermissionStateItem>,
    quitAndReopen: (): Promise<void> =>
      ipcRenderer.invoke("cadet:permissions:quitAndReopen") as Promise<void>,
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: SystemPermissionsState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("cadet:permissions:state", handler);
      return () => {
        ipcRenderer.off("cadet:permissions:state", handler);
      };
    },
  },
  commands: {
    on: (callback) => {
      const handler = (_event: IpcRendererEvent, command: CadetCommand) => {
        callback(command);
      };
      ipcRenderer.on("cadet:command", handler);
      return () => {
        ipcRenderer.off("cadet:command", handler);
      };
    },
  },
  status: {
    setConnection: (status: AssistantStatus): void => {
      ipcRenderer.send("cadet:status:connection", status);
    },
  },
  identity: {
    setName: (name: string): void => {
      ipcRenderer.send("cadet:identity:name", name);
    },
  },
  icon: {
    setAvatar: (png: Uint8Array | null): void => {
      ipcRenderer.send("cadet:icon:setAvatar", png);
    },
    setCharacter: (character, accentHex): void => {
      ipcRenderer.send("cadet:icon:setCharacter", character, accentHex ?? null);
    },
  },
  dock: {
    setBadge: (count: number): void => {
      ipcRenderer.send("cadet:dock:setBadge", count);
    },
  },
  share: {
    shareFile: (bytes: Uint8Array, filename: string): Promise<void> =>
      ipcRenderer.invoke("cadet:share:file", bytes, filename),
  },
  downloads: createDownloadsBridge(ipcRenderer),
  localMode: createLocalModeBridge(ipcRenderer),
  menu: {
    setCloudSession: (has: boolean): Promise<void> =>
      ipcRenderer.invoke("cadet:menu:setCloudSession", has) as Promise<void>,
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("cadet:mainWindow:ensureVisible") as Promise<void>,
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "cadet:mainWindow:setOnboarding",
        active,
      ) as Promise<void>,
  },
  power: {
    onEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
        callback(payload);
      };
      ipcRenderer.on("cadet:power:event", handler);
      return () => {
        ipcRenderer.off("cadet:power:event", handler);
      };
    },
  },
  deepLinks: createDeepLinksBridge(ipcRenderer),
  fileOpen: fileOpenBridge.fileOpen,
  paths: fileOpenBridge.paths,
  feedback: {
    diagnostics: () =>
      ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS) as Promise<
        Record<string, unknown>
      >,
    logs: () => ipcRenderer.invoke(FEEDBACK_LOGS) as Promise<string>,
  },
  connectivity: {
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: ConnectivityState) => {
        callback(state);
      };
      ipcRenderer.on("cadet:connectivity:state", handler);
      // Emit the current state so late subscribers (window loaded after
      // the first probe) don't wait for the next state transition.
      void (
        ipcRenderer.invoke(
          "cadet:connectivity:get",
        ) as Promise<ConnectivityState>
      ).then(callback);
      return () => {
        ipcRenderer.off("cadet:connectivity:state", handler);
      };
    },
    get: () =>
      ipcRenderer.invoke(
        "cadet:connectivity:get",
      ) as Promise<ConnectivityState>,
    setDevice: (online: boolean): void => {
      ipcRenderer.send("cadet:connectivity:device", online);
    },
    retry: () =>
      ipcRenderer.invoke(
        "cadet:connectivity:retry",
      ) as Promise<ConnectivityState>,
  },
  notifications: createNotificationsBridge(ipcRenderer),
  bundleConfirm: createBundleConfirmBridge(ipcRenderer),
  quickInput: {
    submit: (message: string): Promise<void> =>
      ipcRenderer.invoke("cadet:quickInput:submit", message) as Promise<void>,
    dismiss: (): Promise<void> =>
      ipcRenderer.invoke("cadet:quickInput:dismiss") as Promise<void>,
  },
  commandPalette: {
    open: (): Promise<void> =>
      ipcRenderer.invoke("cadet:commandPalette:open") as Promise<void>,
    dismiss: (): Promise<void> =>
      ipcRenderer.invoke("cadet:commandPalette:dismiss") as Promise<void>,
    select: (command: CadetCommand): Promise<void> =>
      ipcRenderer.invoke(
        "cadet:commandPalette:select",
        command,
      ) as Promise<void>,
  },
  dictationOverlay: {
    setState: (state: DictationOverlayMessage): void => {
      ipcRenderer.send("cadet:dictationOverlay:setState", state);
    },
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: DictationOverlayState,
      ) => {
        callback(payload);
      };
      ipcRenderer.on("cadet:dictationOverlay:state", handler);
      return () => {
        ipcRenderer.off("cadet:dictationOverlay:state", handler);
      };
    },
    getState: (): Promise<DictationOverlayState | null> =>
      ipcRenderer.invoke(
        "cadet:dictationOverlay:getState",
      ) as Promise<DictationOverlayState | null>,
    requestStop: (): void => {
      ipcRenderer.send("cadet:dictationOverlay:requestStop");
    },
    onStopRequested: (callback) => {
      const handler = () => {
        callback();
      };
      ipcRenderer.on("cadet:dictationOverlay:stopRequested", handler);
      return () => {
        ipcRenderer.off("cadet:dictationOverlay:stopRequested", handler);
      };
    },
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send("cadet:dictationOverlay:setInteractive", interactive);
    },
    setHitRegion: (region: DictationOverlayHitRegion | null): void => {
      ipcRenderer.send("cadet:dictationOverlay:setHitRegion", region);
    },
  },
  voiceActivity: {
    start: (state: VoiceActivityStart): void => {
      ipcRenderer.send("cadet:voiceActivity:start", state);
    },
    update: (content: VoiceActivityContent): void => {
      ipcRenderer.send("cadet:voiceActivity:update", content);
    },
    end: (): void => {
      ipcRenderer.send("cadet:voiceActivity:end");
    },
    control: (control: VoiceActivityControl): void => {
      ipcRenderer.send("cadet:voiceActivity:control", control);
    },
    onControl: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: VoiceActivityControl,
      ) => {
        callback(payload);
      };
      ipcRenderer.on("cadet:voiceActivity:controlEvent", handler);
      return () => {
        ipcRenderer.off("cadet:voiceActivity:controlEvent", handler);
      };
    },
  },
  companion: {
    getState: (): Promise<CompanionSurfaceState | null> =>
      ipcRenderer.invoke(
        "cadet:companion:getState",
      ) as Promise<CompanionSurfaceState | null>,
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: CompanionSurfaceState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("cadet:companion:state", handler);
      return () => {
        ipcRenderer.off("cadet:companion:state", handler);
      };
    },
    getIntroAnnouncement: (): Promise<boolean> =>
      ipcRenderer.invoke(
        "cadet:companion:getIntroAnnouncement",
      ) as Promise<boolean>,
    answerIntroAnnouncement: (
      action: CompanionIntroAnnouncementAction,
    ): void => {
      ipcRenderer.send("cadet:companion:answerIntroAnnouncement", action);
    },
    onIntroAnnouncement: (callback) => {
      const handler = (_event: IpcRendererEvent, open: boolean) => {
        callback(open);
      };
      ipcRenderer.on("cadet:companion:introAnnouncement", handler);
      return () => {
        ipcRenderer.off("cadet:companion:introAnnouncement", handler);
      };
    },
    getIntroStage: (): Promise<boolean> =>
      ipcRenderer.invoke("cadet:companion:getIntroStage") as Promise<boolean>,
    onIntroStage: (callback) => {
      const handler = (_event: IpcRendererEvent, staged: boolean) => {
        callback(staged);
      };
      ipcRenderer.on("cadet:companion:introStage", handler);
      return () => {
        ipcRenderer.off("cadet:companion:introStage", handler);
      };
    },
    getIntroChord: (): Promise<CompanionIntroCallControl | null> =>
      ipcRenderer.invoke(
        "cadet:companion:getIntroChord",
      ) as Promise<CompanionIntroCallControl | null>,
    onIntroChord: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        control: CompanionIntroCallControl | null,
      ) => {
        callback(control);
      };
      ipcRenderer.on("cadet:companion:introChord", handler);
      return () => {
        ipcRenderer.off("cadet:companion:introChord", handler);
      };
    },
    onIntroReport: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        report: CompanionIntroReport,
      ) => {
        callback(report);
      };
      ipcRenderer.on("cadet:companion:introReport", handler);
      return () => {
        ipcRenderer.off("cadet:companion:introReport", handler);
      };
    },
    // Reports main held because there was no window listening for them, which
    // is how the run's own ending survives an app the user had closed. Taken,
    // not read: a second reader would report the same rows again.
    takeIntroReports: (): Promise<CompanionIntroReport[]> =>
      ipcRenderer.invoke("cadet:companion:takeIntroReports") as Promise<
        CompanionIntroReport[]
      >,
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send("cadet:companion:setInteractive", interactive);
    },
    moveBy: (dx: number, dy: number): void => {
      ipcRenderer.send("cadet:companion:moveBy", dx, dy);
    },
    release: (): void => {
      ipcRenderer.send("cadet:companion:release");
    },
    startVoice: (): void => {
      ipcRenderer.send("cadet:companion:startVoice");
    },
    toggleWatch: (pick?: CompanionCapturePick): void => {
      // Sent with no argument at all when there is no pick, so a main that
      // predates the picker still sees the empty tuple its schema expects.
      if (pick === undefined) {
        ipcRenderer.send("cadet:companion:toggleWatch");
        return;
      }
      ipcRenderer.send("cadet:companion:toggleWatch", pick);
    },
    listCaptureSources: (): Promise<CompanionCaptureSources> =>
      ipcRenderer.invoke(
        "cadet:companion:listCaptureSources",
      ) as Promise<CompanionCaptureSources>,
    setScreenShare: (pick?: CompanionCapturePick): void => {
      // Two shapes rather than an optional element, the way `toggleWatch` is
      // sent: a stop carries nothing at all.
      if (pick === undefined) {
        ipcRenderer.send("cadet:companion:setScreenShare");
        return;
      }
      ipcRenderer.send("cadet:companion:setScreenShare", pick);
    },
    setAnnotating: (annotating: boolean): void => {
      ipcRenderer.send("cadet:companion:setAnnotating", annotating);
    },
    toggleAnnotating: (): void => {
      ipcRenderer.send("cadet:companion:toggleAnnotating");
    },
    clearMarks: (): void => {
      ipcRenderer.send("cadet:companion:clearMarks");
    },
    setAnnotationTool: (tool: CompanionAnnotationTool): void => {
      ipcRenderer.send("cadet:companion:setAnnotationTool", tool);
    },
    annotateShare: (
      phase: CompanionAnnotationPhase,
      strokes: readonly CompanionAnnotationStroke[],
      ink: string,
    ): void => {
      ipcRenderer.send("cadet:companion:annotateShare", phase, strokes, ink);
    },
    setFrameScrolling: (scrolling: boolean): void => {
      ipcRenderer.send("cadet:companion:setFrameScrolling", scrolling);
    },
    frameDrawn: (): void => {
      ipcRenderer.send("cadet:companion:frameDrawn");
    },
    sharedFrame: (target: WatchCaptureTarget): void => {
      ipcRenderer.send("cadet:companion:sharedFrame", target);
    },
    captureScreen: (
      target: WatchCaptureTarget,
    ): Promise<ScreenCaptureFrame | null> =>
      ipcRenderer.invoke(
        "cadet:companion:captureScreen",
        target,
      ) as Promise<ScreenCaptureFrame | null>,
    shareTargets: (
      target: WatchCaptureTarget,
    ): Promise<ShareTargetSnapshot | null> =>
      ipcRenderer.invoke(
        "cadet:companion:shareTargets",
        target,
      ) as Promise<ShareTargetSnapshot | null>,
    captureSourceThumbnail: (
      target: WatchCaptureTarget,
    ): Promise<string | null> =>
      ipcRenderer.invoke(
        "cadet:companion:captureSourceThumbnail",
        target,
      ) as Promise<string | null>,
    answerWatchRetro: (open: boolean): void => {
      ipcRenderer.send("cadet:companion:answerWatchRetro", open);
    },
    ...createDictationOfferBridge(ipcRenderer),
    answerDictationOffer: (
      answer: DictationOfferAnswer,
      offerId: string,
    ): void => {
      ipcRenderer.send("cadet:companion:answerDictationOffer", answer, offerId);
    },
    answerPopover: (
      answer: CompanionPopoverAnswer,
      popoverId: string,
    ): void => {
      ipcRenderer.send("cadet:companion:answerPopover", answer, popoverId);
    },
    setPopoverSize: (
      popoverId: string,
      width: number,
      height: number,
    ): void => {
      ipcRenderer.send(
        "cadet:companion:setPopoverSize",
        popoverId,
        width,
        height,
      );
    },
    setPopoverView: (popoverId: string, view: CompanionPopoverView): void => {
      ipcRenderer.send("cadet:companion:setPopoverView", popoverId, view);
    },
    setAttachedPopoverHeight: (popoverId: string, height: number): void => {
      ipcRenderer.send(
        "cadet:companion:setAttachedPopoverHeight",
        popoverId,
        height,
      );
    },
    togglePicker: (picker: CompanionPicker): void => {
      ipcRenderer.send("cadet:companion:togglePicker", picker);
    },
    openLink: (url: string): void => {
      ipcRenderer.send("cadet:companion:openLink", url);
    },
    takesPrompts: (): Promise<boolean> =>
      ipcRenderer.invoke("cadet:companion:takesPrompts") as Promise<boolean>,
    activate: (): void => {
      ipcRenderer.send("cadet:companion:activate");
    },
    setContext: (context: CompanionContext): void => {
      ipcRenderer.send("cadet:companion:setContext", context);
    },
    advanceIntro: (action: CompanionIntroAction): void => {
      ipcRenderer.send("cadet:companion:advanceIntro", action);
    },
    showContextMenu: (): void => {
      ipcRenderer.send("cadet:companion:contextMenu");
    },
  },
  popout: {
    open: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke("cadet:popout:open", conversationId) as Promise<void>,
  },
  update: createUpdateBridge(ipcRenderer),
};

contextBridge.exposeInMainWorld("cadet", bridge);

const cadetConfig = ipcRenderer.sendSync("cadet:config:get") as {
  webUrl: string;
  cloudUrl: string;
  deviceId: string | null;
  version?: string;
} | null;
if (cadetConfig) {
  contextBridge.exposeInMainWorld("__CADET_CONFIG__", cadetConfig);
}

const flagOverrides: Record<string, boolean | string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("CADET_FLAG_") || value === undefined) continue;
  const flagKey = key
    .slice("CADET_FLAG_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  const lower = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) flagOverrides[flagKey] = true;
  else if (["false", "0", "no", "off"].includes(lower))
    flagOverrides[flagKey] = false;
  else flagOverrides[flagKey] = value.trim();
}
if (Object.keys(flagOverrides).length > 0) {
  contextBridge.exposeInMainWorld("__CADET_FLAG_OVERRIDES__", flagOverrides);
}

declare global {
  interface Window {
    cadet: CadetBridge;
    __CADET_FLAG_OVERRIDES__?: Record<string, boolean | string>;
  }
}
