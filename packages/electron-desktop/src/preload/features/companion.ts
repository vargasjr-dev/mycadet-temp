import { ipcRenderer, type IpcRendererEvent } from "electron";

import { dictationOfferBridge } from "../factories";
import type {
  CadetBridge,
  CompanionAnnotationPhase,
  CompanionAnnotationStroke,
  CompanionAnnotationTool,
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionContext,
  CompanionIntroAction,
  CompanionIntroAnnouncementAction,
  CompanionIntroCallControl,
  CompanionIntroReport,
  CompanionPicker,
  CompanionPopoverAnswer,
  CompanionPopoverView,
  CompanionSurfaceState,
  DictationOfferAnswer,
  ScreenCaptureFrame,
  ShareTargetSnapshot,
  WatchCaptureTarget,
} from "@mycadet/ipc-contract";

/**
 * The companion's bridge: the floating always-present window's surface
 * state, intro flow, annotation, capture, and popover seams. Every
 * desktop's main process serves these channels — the shells that never
 * open a companion simply leave the surface idle, and the renderer
 * feature-detects it either way.
 */
// The one seam where the renderer trusts the main process: `invoke`
// resolves to whatever the channel's handler returned. Each method names
// the payload contract it expects; the contracts live in
// @mycadet/ipc-contract, shared with the handlers that produce them.
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const result: T = await ipcRenderer.invoke(channel, ...args);
  return result;
};

export const companionBridge: CadetBridge["companion"] = {
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
  answerIntroAnnouncement: (action: CompanionIntroAnnouncementAction): void => {
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
    invoke<ScreenCaptureFrame | null>("cadet:companion:captureScreen", target),
  shareTargets: (
    target: WatchCaptureTarget,
  ): Promise<ShareTargetSnapshot | null> =>
    invoke<ShareTargetSnapshot | null>("cadet:companion:shareTargets", target),
  captureSourceThumbnail: (
    target: WatchCaptureTarget,
  ): Promise<string | null> =>
    invoke<string | null>("cadet:companion:captureSourceThumbnail", target),
  answerWatchRetro: (open: boolean): void => {
    ipcRenderer.send("cadet:companion:answerWatchRetro", open);
  },
  ...dictationOfferBridge,
  answerDictationOffer: (
    answer: DictationOfferAnswer,
    offerId: string,
  ): void => {
    ipcRenderer.send("cadet:companion:answerDictationOffer", answer, offerId);
  },
  answerPopover: (answer: CompanionPopoverAnswer, popoverId: string): void => {
    ipcRenderer.send("cadet:companion:answerPopover", answer, popoverId);
  },
  setPopoverSize: (popoverId: string, width: number, height: number): void => {
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
};
