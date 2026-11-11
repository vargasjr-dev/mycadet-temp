import { createPermissionSetupBridge } from "@mycadet/electron-desktop/preload";
import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";

import { createFileOpenPreloadBridge } from "@mycadet/electron-desktop/file-open-preload";

import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  CompanionAnnotationPhase,
  CompanionAnnotationStroke,
  CompanionAnnotationTool,
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

// The one seam where the renderer trusts the main process: `invoke` resolves
// to whatever the channel's handler returned. Each bridge method names the
// payload contract it expects (`invoke<T>`); the contracts themselves live
// in @mycadet/ipc-contract, shared with the handlers that produce them.
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const result: T = await ipcRenderer.invoke(channel, ...args);
  return result;
};

const bridge: CadetBridge = {
  platform: "electron",
  hostOS: "macos",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      invoke<AppVersionInfo>("cadet:app:versionInfo"),
    openWebsite: (): Promise<void> => invoke<void>("cadet:app:openWebsite"),
  },
  text: {
    insertIntoFrontApp: (text: string): Promise<TextInsertionResult> =>
      invoke<TextInsertionResult>("cadet:text:insertIntoFrontApp", text),
    openAutomationSettings: (): Promise<void> =>
      invoke<void>("cadet:text:openAutomationSettings"),
    undoInFrontApp: (): Promise<TextInsertionResult> =>
      invoke<TextInsertionResult>("cadet:text:undoInFrontApp"),
  },
  auth: {
    startOAuth: (options: {
      loginHint?: string;
      intent?: string;
    }): Promise<{ sessionToken: string }> =>
      invoke<{ sessionToken: string }>("cadet:auth:startOAuth", options),
    cancelOAuth: (): Promise<void> => invoke<void>("cadet:auth:cancelOAuth"),
    getSessionToken: (): string | null =>
      ((): string | null => {
        const token: string | null = ipcRenderer.sendSync(
          "cadet:auth:getSessionToken",
        );
        return token;
      })(),
    signOut: (): Promise<void> => invoke<void>("cadet:auth:signOut"),
  },
  hotkeys: createHotkeysBridge(ipcRenderer),
  launchAtLogin: createLaunchAtLoginBridge(ipcRenderer),
  diagnostics: {
    setShareDiagnostics: (enabled: boolean): void => {
      ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
    },
  },
  helper: {
    ping: () => invoke<"pong">("cadet:helper:ping"),
    getState: () => invoke<HelperState>("cadet:helper:state:get"),
    restart: () => invoke<HelperRestartResult>("cadet:helper:restart"),
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
        invoke<ModifierHoldRegistrationResult>(
          HELPER_HOTKEY_SET_MODIFIER_HOLD,
          hold,
        ),
      setChords: (binding: ChordBinding): Promise<ChordRegistrationResult> =>
        invoke<ChordRegistrationResult>(HELPER_HOTKEY_SET_CHORDS, binding),
      readFrontSelection: (): Promise<HotkeySelectionResult> =>
        invoke<HotkeySelectionResult>(HELPER_HOTKEY_READ_FRONT_SELECTION),
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
        invoke<string[]>(HELPER_APPS_RUNNING, [...bundleIds]),
      quit: (bundleId: string): Promise<boolean> =>
        invoke<boolean>(HELPER_APPS_QUIT, bundleId),
      frontmost: (): Promise<string | null> =>
        invoke<string | null>(HELPER_APPS_FRONTMOST),
    },
    input: {
      setActivityWatch: (enable: boolean): Promise<boolean> =>
        invoke<boolean>(HELPER_INPUT_SET_ACTIVITY_WATCH, enable),
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
        invoke<DictationPartialsResult>(
          HELPER_DICTATION_SET_PARTIALS,
          enable,
          deviceName,
          pushAudio,
        ),
      pushAudioChunk: (chunk: ArrayBuffer): void => {
        ipcRenderer.send("cadet:helper:dictation:audio", chunk);
      },
      onPartial: subscribeDictationEvent(HELPER_DICTATION_PARTIAL_EVENT),
      onFinalized: subscribeDictationEvent(HELPER_DICTATION_FINALIZED_EVENT),
      transcribe: (audio: ArrayBuffer): Promise<DictationTranscribeResult> =>
        invoke<DictationTranscribeResult>(HELPER_DICTATION_TRANSCRIBE, audio),
      onTranscribed: subscribeDictationEvent(
        HELPER_DICTATION_TRANSCRIBED_EVENT,
      ),
    },
  },
  permissions: {
    setup: createPermissionSetupBridge(ipcRenderer),
    getState: (): Promise<SystemPermissionsState> =>
      invoke<SystemPermissionsState>("cadet:permissions:getState"),
    request: (
      kind: SystemPermissionKind,
      presentation?: Parameters<CadetBridge["permissions"]["request"]>[1],
    ): Promise<SystemPermissionStateItem> =>
      presentation
        ? invoke<SystemPermissionStateItem>(
            "cadet:permissions:request",
            kind,
            presentation,
          )
        : invoke<SystemPermissionStateItem>("cadet:permissions:request", kind),
    openSettings: (
      kind: SystemPermissionKind,
    ): Promise<SystemPermissionStateItem> =>
      invoke<SystemPermissionStateItem>("cadet:permissions:openSettings", kind),
    quitAndReopen: (): Promise<void> =>
      invoke<void>("cadet:permissions:quitAndReopen"),
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
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      invoke<void>("cadet:mainWindow:ensureVisible"),
    setOnboarding: (active: boolean): Promise<void> =>
      invoke<void>("cadet:mainWindow:setOnboarding", active),
    navigateTo: (url: string): Promise<void> =>
      invoke<void>("cadet:mainWindow:navigateTo", url),
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
    diagnostics: () => invoke<Record<string, unknown>>(FEEDBACK_DIAGNOSTICS),
    logs: () => invoke<string>(FEEDBACK_LOGS),
  },
  connectivity: {
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: ConnectivityState) => {
        callback(state);
      };
      ipcRenderer.on("cadet:connectivity:state", handler);
      // Emit the current state so late subscribers (window loaded after
      // the first probe) don't wait for the next state transition.
      void invoke<ConnectivityState>("cadet:connectivity:get").then(callback);
      return () => {
        ipcRenderer.off("cadet:connectivity:state", handler);
      };
    },
    get: () => invoke<ConnectivityState>("cadet:connectivity:get"),
    setDevice: (online: boolean): void => {
      ipcRenderer.send("cadet:connectivity:device", online);
    },
    retry: () => invoke<ConnectivityState>("cadet:connectivity:retry"),
  },
  notifications: createNotificationsBridge(ipcRenderer),
  bundleConfirm: createBundleConfirmBridge(ipcRenderer),
  quickInput: {
    submit: (message: string): Promise<void> =>
      invoke<void>("cadet:quickInput:submit", message),
    dismiss: (): Promise<void> => invoke<void>("cadet:quickInput:dismiss"),
  },
  commandPalette: {
    open: (): Promise<void> => invoke<void>("cadet:commandPalette:open"),
    dismiss: (): Promise<void> => invoke<void>("cadet:commandPalette:dismiss"),
    select: (command: CadetCommand): Promise<void> =>
      invoke<void>("cadet:commandPalette:select", command),
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
      invoke<DictationOverlayState | null>("cadet:dictationOverlay:getState"),
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
      invoke<CompanionSurfaceState | null>("cadet:companion:getState"),
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
      invoke<boolean>("cadet:companion:getIntroAnnouncement"),
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
      invoke<boolean>("cadet:companion:getIntroStage"),
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
      invoke<CompanionIntroCallControl | null>("cadet:companion:getIntroChord"),
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
      invoke<CompanionIntroReport[]>("cadet:companion:takeIntroReports"),
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
      invoke<CompanionCaptureSources>("cadet:companion:listCaptureSources"),
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
      invoke<ScreenCaptureFrame | null>(
        "cadet:companion:captureScreen",
        target,
      ),
    shareTargets: (
      target: WatchCaptureTarget,
    ): Promise<ShareTargetSnapshot | null> =>
      invoke<ShareTargetSnapshot | null>(
        "cadet:companion:shareTargets",
        target,
      ),
    captureSourceThumbnail: (
      target: WatchCaptureTarget,
    ): Promise<string | null> =>
      invoke<string | null>("cadet:companion:captureSourceThumbnail", target),
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
      invoke<boolean>("cadet:companion:takesPrompts"),
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
      invoke<void>("cadet:popout:open", conversationId),
  },
  update: createUpdateBridge(ipcRenderer),
};

contextBridge.exposeInMainWorld("cadet", bridge);

declare global {
  interface Window {
    cadet: CadetBridge;
  }
}
