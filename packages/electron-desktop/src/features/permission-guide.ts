import path from "node:path";

import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  type NativeImage,
  type Rectangle,
  type WebContents,
} from "electron";
import { z } from "zod";
import {
  DRAGGABLE_PERMISSION_KINDS,
  PERMISSION_GUIDE_MAX_HEIGHT,
  PERMISSION_GUIDE_CANCEL,
  PERMISSION_SETUP_BEGIN,
  PERMISSION_GUIDE_GET,
  PERMISSION_GUIDE_STATE,
  PERMISSION_GUIDE_READY,
  PERMISSION_GUIDE_DISMISS,
  PERMISSION_GUIDE_DRAG,
  PERMISSION_GUIDE_REVEAL,
  type DraggablePermissionKind,
  type PermissionGuideState,
  type PermissionSourceRect,
} from "@mycadet/ipc-contract";
import { createFloatingWindow } from "../floating-window";
import { getAccentHex, getAvatarPng, onAvatarChange } from "../avatar";
import { handle, on } from "../ipc";
import log from "../app-logger";
import { getPermissionsService } from "./permissions";

import { PERMISSION_GUIDE_MIN_HEIGHT } from "@mycadet/ipc-contract";

export const GUIDE_WIDTH = 560;
export const GUIDE_HEIGHT = PERMISSION_GUIDE_MIN_HEIGHT;

/** Keep the app list exposed, with the guide tucked against its lower edge. */
export function permissionGuideBounds(
  workArea: Rectangle,
  settings?: Rectangle,
  contentHeight = GUIDE_HEIGHT,
): Rectangle {
  const width = Math.min(GUIDE_WIDTH, workArea.width - 24);
  const height = Math.min(contentHeight, workArea.height - 24);
  const right = settings
    ? settings.x + settings.width - 16
    : workArea.x + (workArea.width + width) / 2;
  const bottom = settings
    ? settings.y + settings.height - 16
    : workArea.y + workArea.height - 24;
  return {
    x: Math.round(
      Math.max(
        workArea.x + 12,
        Math.min(right - width, workArea.x + workArea.width - width - 12),
      ),
    ),
    y: Math.round(
      Math.max(
        workArea.y + 12,
        Math.min(bottom - height, workArea.y + workArea.height - height - 12),
      ),
    ),
    width,
    height,
  };
}

/**
 * The surfaces only the shell's OS has: the app the user drags into the OS
 * settings list, and — where the OS even lets a window be found — the
 * settings windows the guide follows.
 */
export interface PermissionGuideInputs {
  /** The helper app to drag into the list, with its icon. */
  dragTarget(): Promise<{ file: string; icon: NativeImage }>;
  /** Open the kind's settings pane — the guide opens it beside itself. */
  openSettingsPane(kind: DraggablePermissionKind): Promise<void>;
  /** The OS settings windows, when the OS can name them. */
  listSettingsWindows?(): Promise<Array<{ id?: number; bounds: Rectangle }>>;
  /** Runs when the guide yields focus to the OS settings surface. */
  onYieldToSettings?: () => void;
}

const GUIDE = "permission-guide";
const kindSchema = z.enum(DRAGGABLE_PERMISSION_KINDS);
const idSchema = z.number().int().positive();
const sourceSchema = z.object({
  x: z.number().finite().min(0).max(10_000),
  y: z.number().finite().min(0).max(10_000),
  width: z.number().finite().min(1).max(2_000),
  height: z.number().finite().min(1).max(2_000),
});

interface GuideSession {
  state: PermissionGuideState;
  file: string;
  icon: NativeImage;
  bundleIcon: NativeImage;
  window: BrowserWindow;
  workArea: Rectangle;
  timers: ReturnType<typeof setInterval>[];
  ready: boolean;
  yieldedToSettings: boolean;
  settingsWindowId?: number;
  height: number;
  startedAt: number;
}

let guide: GuideSession | null = null;
let generation = 0;
let guideOwner: WebContents | undefined;
let guideInputs: PermissionGuideInputs | undefined;

function refreshGuideAppearance(session: GuideSession): void {
  const png = getAvatarPng();
  const avatar = png ? nativeImage.createFromBuffer(png) : null;
  session.icon = avatar && !avatar.isEmpty() ? avatar : session.bundleIcon;
  session.state = {
    ...session.state,
    appIcon: session.icon.toDataURL(),
    accentHex: getAccentHex() ?? undefined,
  };
}

function publishGuide(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PERMISSION_GUIDE_STATE, guide?.state ?? null);
    }
  }
}

function dismissGuide(returnToOwner = false): void {
  const owner =
    returnToOwner && guideOwner && !guideOwner.isDestroyed()
      ? BrowserWindow.fromWebContents(guideOwner)
      : null;
  guideOwner = undefined;
  generation += 1;
  const previous = guide;
  guide = null;
  for (const timer of previous?.timers ?? []) {
    clearInterval(timer);
  }
  if (previous && !previous.window.isDestroyed()) {
    previous.window.destroy();
  }
  publishGuide();
  if (owner && !owner.isDestroyed()) {
    owner.show();
  }
}

/** The rectangle fields a nudge is allowed to move. */
const rectangleKeys: (keyof Rectangle)[] = ["x", "y", "width", "height"];

function guideSender(id: number, sender: WebContents): GuideSession | null {
  return guide?.state.id === id && guide.window.webContents === sender
    ? guide
    : null;
}

async function followSettings(session: GuideSession): Promise<void> {
  const windows = (await guideInputs?.listSettingsWindows?.()) ?? [];
  if (guide !== session || !session.ready || session.yieldedToSettings) {
    return;
  }
  // Authentication dialogs can precede the main window in the window list.
  const settings =
    session.settingsWindowId === undefined
      ? windows.sort(
          (a, b) =>
            b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
        )[0]
      : windows.find((win) => win.id === session.settingsWindowId);
  if (!settings) {
    return;
  }
  session.settingsWindowId = settings.id;
  session.workArea = screen.getDisplayMatching(settings.bounds).workArea;
  const next = permissionGuideBounds(
    session.workArea,
    settings.bounds,
    session.height,
  );
  const current = session.window.getBounds();
  if (rectangleKeys.some((key) => next[key] !== current[key])) {
    session.window.setBounds(
      next,
      !systemPreferences.getAnimationSettings().prefersReducedMotion,
    );
  }
}

function yieldToSettings(session: GuideSession): void {
  guideInputs?.onYieldToSettings?.();
  session.yieldedToSettings = true;
  session.window.setAlwaysOnTop(false);
}

/**
 * Open the kind's Settings pane with the floating guide beside it, the
 * guide holding the shell's drag target. Settles once the guide is up; the
 * guide closes itself when the grant lands.
 */
export async function beginPermissionGuide(
  service: {
    state(): Promise<Record<string, { status: string }>>;
    refresh(): Promise<Record<string, { status: string }>>;
  },
  kind: DraggablePermissionKind,
  sender?: WebContents,
  source?: PermissionSourceRect,
): Promise<void> {
  if (!guideInputs) {
    return;
  }
  dismissGuide();
  const id = generation;
  guideOwner = sender;
  const state = await service.state();
  if (id !== generation) {
    return;
  }
  if (state[kind].status === "granted" || state[kind].status === "restricted") {
    guideOwner = undefined;
    return;
  }
  const { file, icon } = await guideInputs.dragTarget();
  if (icon.isEmpty()) {
    throw new Error(
      "The permission app is unavailable. Reinstall Cadet and try again.",
    );
  }
  if (id !== generation) {
    return;
  }
  const owner = sender ? BrowserWindow.fromWebContents(sender) : null;
  const ownerBounds = owner?.getBounds();
  const workArea = ownerBounds
    ? screen.getDisplayMatching(ownerBounds).workArea
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const initial =
    ownerBounds && source
      ? {
          x: Math.round(ownerBounds.x + source.x),
          y: Math.round(ownerBounds.y + source.y),
          width: Math.round(source.width),
          height: Math.round(source.height),
        }
      : permissionGuideBounds(workArea);
  const win = createFloatingWindow({
    kind: GUIDE,
    route: "/floating/permission-guide",
    width: GUIDE_WIDTH,
    height: GUIDE_HEIGHT,
    callerShows: true,
    visibleOnAllWorkspaces: false,
    browserWindow: {
      hasShadow: true,
      movable: true,
      minimizable: false,
      maximizable: false,
    },
  });
  win.setBounds(initial);
  const session: GuideSession = {
    state: {
      id,
      kind,
      appName: path.basename(file, path.extname(file)),
      appIcon: icon.toDataURL(),
      error: false,
    },
    file,
    icon,
    bundleIcon: icon,
    window: win,
    workArea,
    timers: [],
    ready: false,
    yieldedToSettings: false,
    height: GUIDE_HEIGHT,
    startedAt: Date.now(),
  };
  refreshGuideAppearance(session);
  guide = session;
  win.on("closed", () => {
    if (guide === session) {
      dismissGuide();
    }
  });
  publishGuide();
  try {
    await guideInputs.openSettingsPane(kind);
  } catch (error) {
    if (guide === session) {
      dismissGuide();
    }
    throw error;
  }
  if (guide !== session) {
    return;
  }
  let checking = false;
  session.timers.push(
    setInterval(() => {
      if (Date.now() - session.startedAt > 5 * 60_000) {
        dismissGuide();
        return;
      }
      if (checking) {
        return;
      }
      checking = true;
      void getPermissionsService()
        ?.refresh()
        .then((next) => {
          if (guide === session && next[kind].status === "granted") {
            dismissGuide();
          }
        })
        .catch((error: unknown) =>
          log.warn("[permissions] refresh failed:", error),
        )
        .finally(() => {
          checking = false;
        });
    }, 2_000),
  );
  let positioning = false;
  session.timers.push(
    setInterval(() => {
      if (positioning || !session.ready || session.yieldedToSettings) {
        return;
      }
      positioning = true;
      void followSettings(session)
        .catch(() => undefined)
        .finally(() => {
          positioning = false;
        });
    }, 500),
  );
}

export const installPermissionGuide = (
  inputs?: PermissionGuideInputs,
): void => {
  if (!inputs) {
    return;
  }
  guideInputs = inputs;
  const service = getPermissionsService();
  if (!service) {
    return;
  }
  onAvatarChange(() => {
    if (guide) {
      refreshGuideAppearance(guide);
      publishGuide();
    }
  });
  on(PERMISSION_GUIDE_CANCEL, z.tuple([]), (_args, event) => {
    if (guideOwner === event.sender) {
      dismissGuide();
    }
  });
  handle(
    PERMISSION_SETUP_BEGIN,
    z.tuple([kindSchema, sourceSchema.optional()]),
    async ([kind, source], event) => {
      await beginPermissionGuide(service, kind, event.sender, source);
      return (await service.refresh())[kind];
    },
  );
  handle(PERMISSION_GUIDE_GET, z.tuple([]), () => guide?.state ?? null);
  on(
    PERMISSION_GUIDE_READY,
    z.tuple([
      idSchema,
      z.number().int().min(GUIDE_HEIGHT).max(PERMISSION_GUIDE_MAX_HEIGHT),
    ]),
    ([id, height], event) => {
      const session = guideSender(id, event.sender);
      if (
        !session ||
        session.yieldedToSettings ||
        (session.ready && session.height === height)
      ) {
        return;
      }
      session.ready = true;
      session.height = height;
      session.window.showInactive();
      session.window.setBounds(
        permissionGuideBounds(session.workArea, undefined, session.height),
        !systemPreferences.getAnimationSettings().prefersReducedMotion,
      );
      void followSettings(session).catch(() => undefined);
    },
  );
  on(PERMISSION_GUIDE_DISMISS, z.tuple([idSchema]), ([id], event) => {
    if (guideSender(id, event.sender)) {
      dismissGuide(true);
    }
  });
  on(PERMISSION_GUIDE_DRAG, z.tuple([idSchema]), ([id], event) => {
    const session = guideSender(id, event.sender);
    if (!session) {
      return;
    }
    try {
      // The native drop can open authentication before startDrag returns.
      yieldToSettings(session);
      event.sender.startDrag({
        file: session.file,
        icon: session.icon.resize({ width: 64, height: 64 }),
      });
    } catch (error) {
      log.warn("[permissions] native drag failed:", error);
      if (guide !== session) {
        return;
      }
      session.yieldedToSettings = false;
      session.window.setAlwaysOnTop(true, "floating");
      session.state = { ...session.state, error: true };
      publishGuide();
    }
  });
  handle(PERMISSION_GUIDE_REVEAL, z.tuple([idSchema]), ([id], event) => {
    const session = guideSender(id, event.sender);
    if (session) {
      yieldToSettings(session);
      shell.showItemInFolder(session.file);
    }
  });
  app.on("before-quit", () => dismissGuide());
};
