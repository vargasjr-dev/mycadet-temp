import { BrowserWindow, type WebContents } from "electron";
import { z } from "zod";

import {
  FN_CLAIMANT_BUNDLE_IDS,
  HELPER_APPS_FRONTMOST,
  HELPER_APPS_QUIT,
  HELPER_APPS_RUNNING,
  HELPER_INPUT_ACTIVITY_EVENT,
  HELPER_INPUT_SET_ACTIVITY_WATCH,
  HELPER_HOTKEY_READ_FRONT_SELECTION,
  HELPER_HOTKEY_SET_CHORDS,
  HELPER_HOTKEY_SET_MODIFIER_HOLD,
} from "@mycadet/ipc-contract";
import type {
  ChordBinding,
  ChordRegistrationResult,
  HotkeyEvent,
  HotkeySelectionResult,
  ModifierHold,
  ModifierHoldRegistrationResult,
} from "@mycadet/ipc-contract";

import { handle } from "../ipc";
import log from "../app-logger";
import { getSharedHelperClient } from "../native-helper-client";
import { JsonRpcHelperError } from "@mycadet/native-sidecar/supervisor";

import {
  coachmarkPressed,
  provideCoachmarkPressWatch,
  watchedCoachmarkPress,
} from "./coachmark-press-watch";
import { isPointerOnCompanion } from "./companion-pointer";
import {
  frameScrollEnded,
  isFrameScrollWatched,
  provideFrameScrollWatch,
} from "./frame-scroll-watch";

/**
 * Where a pointed-at control is, in screen points with a top-left origin.
 * The shell that draws coachmarks owns the geometry; this feature only
 * carries the rectangles to the helper.
 */
export interface HelperHotkeyPressRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The shell's watch-state surfaces. The wanted-or-not for the scroll and
 * press watches lives where the frames and marks put it (a helper that comes
 * back from a crash is put back to watching the same way), so the state is
 * the shell's and the sends over the helper are this feature's.
 */
export interface HelperHotkeysWatches {
  /** Hand the shell the sender it calls when the frame asks for a scroll watch. */
  provideFrameScrollWatch(send: (enable: boolean) => void): void;
  /** The frame says the scroll it stepped aside for has ended. */
  frameScrollEnded(): void;
  /** Whether the frame currently wants the scroll watch restored after a restart. */
  isFrameScrollWatched(): boolean;
  /** Hand the shell the sender it calls when the marks ask for a press watch. */
  provideCoachmarkPressWatch(
    send: (rects: readonly HelperHotkeyPressRect[]) => void,
  ): void;
  /** The helper reports a press on mark `index`. */
  coachmarkPressed(index: number): void;
  /** The rectangles the marks currently want watched, or `null` when none. */
  watchedCoachmarkPress(): readonly HelperHotkeyPressRect[] | null;
}

const HOTKEY_EVENT_SCHEMA = z.union([
  z.object({
    kind: z.literal("modifierHold"),
    state: z.enum(["down", "up"]),
    reason: z.enum(["released", "chord", "cancelled"]).optional(),
  }),
  z.object({
    kind: z.literal("chord"),
    state: z.literal("down"),
    key: z.string().length(1),
  }),
]);

const FRONT_SELECTION_SCHEMA = z.object({
  unavailable: z.boolean().optional(),
  holdId: z.number().int().optional(),
  selection: z
    .object({
      text: z.string(),
      truncated: z.boolean(),
      // A helper built before the flag existed says nothing about it, and a
      // selection of unknown editability is one the words are asked about.
      editable: z.boolean().default(false),
    })
    .optional(),
});

const FRONT_SELECTION_MAX_RETRIES = 30;
const FRONT_SELECTION_RETRY_DELAY_MS = 100;

const RUNNING_APPS_SCHEMA = z.object({
  running: z.array(z.string()),
});

const QUIT_APP_SCHEMA = z.object({
  asked: z.boolean(),
});

const FRONTMOST_APP_SCHEMA = z.object({
  bundleId: z.string().nullable(),
});

const FRONT_FOCUS_SCHEMA = z.object({
  focused: z.boolean(),
  takesText: z.boolean(),
});

const HOTKEY_RESULT_SCHEMA = z.object({
  enabled: z.boolean(),
});

/**
 * The binding the helper is currently holding, so a clear that has nothing to
 * clear stays off the wire. Teardown runs on paths the hold was never used on,
 * and the helper's stdin is shared with dictation. Also what a helper that
 * comes back from a crash is handed, so the key survives the restart.
 */
let modifierHoldBinding: ModifierHold = { kind: "off" };

/**
 * The binding the caller last asked for, and the call carrying one to the
 * helper, so the last word wins.
 *
 * Registrations arrive in bursts: a renderer that reloads tears its binding
 * down and puts it back, and both are calls over the same pipe. Run
 * concurrently they can land in the other order, leaving the helper cleared
 * while the app believes it is armed, which reads as the keys going dead until
 * the next restart. Chaining is what keeps the order the caller's.
 */
let desiredModifierHold: ModifierHold = { kind: "off" };
let modifierHoldInFlight: Promise<ModifierHoldRegistrationResult> | null = null;

/**
 * Point the helper's hold detector at a modifier set, or clear it.
 *
 * The set crosses as names rather than a mask: the helper owns which bits a
 * modifier is, left and right hand alike, and neither side should hold a second
 * copy of that table.
 */
const setModifierHold = async (
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> => {
  desiredModifierHold = hold;
  const run = async (): Promise<ModifierHoldRegistrationResult> => {
    await modifierHoldInFlight?.catch(() => undefined);
    // Whatever was asked for last, which may no longer be what this call
    // carried: a burst collapses to one registration rather than a queue of
    // them fighting.
    return applyModifierHold(desiredModifierHold);
  };
  const call = run();
  modifierHoldInFlight = call;
  void call.finally(() => {
    if (modifierHoldInFlight === call) {
      modifierHoldInFlight = null;
    }
  });
  return call;
};

/**
 * The chord binding the helper is holding, and the window that asked for it.
 *
 * Its own owner rather than the hold's: the hold's edges go to whichever
 * window the user last focused, because a hold is a microphone and the user
 * pointed it somewhere. A chord is armed by the one window that can answer it
 * (the one holding the call), so it goes back there whatever is focused, and
 * a pop-out in front cannot swallow a press meant for the session.
 */
let chordBinding: ChordBinding = { kind: "off" };
let chordOwner: WebContents | null = null;
/** Stops watching the owner for the window closing under the binding. */
let releaseChordOwner: (() => void) | null = null;
/** Whether the helper that comes back next is owed the chords it died with. */
let restoreChordsAfterRestart = false;

const sendChords = async (
  binding: ChordBinding,
): Promise<ChordRegistrationResult> => {
  try {
    const result = await getSharedHelperClient().call(
      "hotkey.chords",
      binding.kind === "off"
        ? { enable: false }
        : { enable: true, modifiers: binding.modifiers, keys: binding.keys },
    );
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return { ok: false, reason: "helper returned invalid hotkey result" };
    }
    return { ok: true, enabled: parsed.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

const setChords = async (
  binding: ChordBinding,
  owner: WebContents | null,
): Promise<ChordRegistrationResult> => {
  releaseChordOwner?.();
  releaseChordOwner = null;
  chordBinding = binding;
  chordOwner = binding.kind === "off" ? null : owner;

  // A window that arms chords is watched for going away on its own account,
  // rather than through the hold's ownership: it may hold no hold at all, and
  // a binding left armed with nothing to answer it would go on taking presses
  // that are the user's own again.
  if (chordOwner !== null) {
    const closing = chordOwner;
    const onDestroyed = () => {
      if (chordOwner === closing) {
        void setChords({ kind: "off" }, null);
      }
    };
    closing.once("destroyed", onDestroyed);
    releaseChordOwner = () => {
      closing.off("destroyed", onDestroyed);
    };
  }

  const result = await sendChords(binding);
  restoreChordsAfterRestart = false;
  return result;
};

const applyModifierHold = async (
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> => {
  if (hold.kind === "off" && modifierHoldBinding.kind === "off") {
    return { ok: true, enabled: false };
  }
  modifierHoldBinding = hold;
  return sendModifierHold(hold);
};

const sendModifierHold = async (
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> => {
  try {
    const result = await getSharedHelperClient().call(
      "hotkey.modifierHold",
      hold.kind === "off"
        ? { enable: false }
        : { enable: true, modifiers: hold.modifiers },
    );
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    if (!parsed.success) {
      return { ok: false, reason: "helper returned invalid hotkey result" };
    }
    helperHoldsBinding = hold.kind !== "off" && parsed.data.enabled;
    return { ok: true, enabled: parsed.data.enabled };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Retries Chromium's asynchronous accessibility activation without blocking
 * the native keyboard monitor. The helper binds retries to the original hold
 * and application; an unavailable read never becomes permission to paste.
 */
const readFrontSelection = async (): Promise<HotkeySelectionResult> => {
  try {
    let holdId: number | undefined;
    // Chromium debounces activation for two seconds, so allow tree build time too.
    for (let attempt = 0; attempt <= FRONT_SELECTION_MAX_RETRIES; attempt++) {
      const result = await getSharedHelperClient().call(
        "selection.read",
        holdId === undefined ? undefined : { holdId },
      );
      const parsed = FRONT_SELECTION_SCHEMA.safeParse(result);
      if (!parsed.success) {
        log.warn("[helper] selection read returned an invalid result");
        return { unavailable: true };
      }
      if (!parsed.data.unavailable) {
        return parsed.data.selection ?? null;
      }
      if (
        parsed.data.holdId === undefined ||
        attempt === FRONT_SELECTION_MAX_RETRIES
      ) {
        return { unavailable: true };
      }
      holdId ??= parsed.data.holdId;
      await new Promise((resolve) =>
        setTimeout(resolve, FRONT_SELECTION_RETRY_DELAY_MS),
      );
    }
  } catch (err) {
    log.warn(
      `[helper] selection read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { unavailable: true };
};

/**
 * Which of the named applications are running. A helper that cannot say
 * reads as none running: the voice key arms, which is the answer with no
 * information rather than a key that stays dead on a hunch.
 */
const runningApps = async (bundleIds: string[]): Promise<string[]> => {
  // Only the apps the voice key has business with. The renderer never gets
  // to enumerate the desktop through this.
  const wanted = bundleIds.filter((id) => FN_CLAIMANT_BUNDLE_IDS.includes(id));
  if (wanted.length === 0) {
    return [];
  }
  try {
    const result = await getSharedHelperClient().call("apps.running", {
      bundleIds: wanted,
    });
    const parsed = RUNNING_APPS_SCHEMA.safeParse(result);
    return parsed.success ? parsed.data.running : [];
  } catch (err) {
    log.warn(
      `[helper] running apps query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
};

/**
 * Ask an application to quit. `false` when it was not running or the helper
 * could not ask, and `false` without asking for any app outside the voice
 * key's claimants: this is the one thing the renderer can do to another app,
 * and the allowlist is held here rather than trusted from there.
 */
const quitApp = async (bundleId: string): Promise<boolean> => {
  if (!FN_CLAIMANT_BUNDLE_IDS.includes(bundleId)) {
    log.warn(`[helper] refused to quit ${bundleId}: not a voice key claimant`);
    return false;
  }
  try {
    const result = await getSharedHelperClient().call("apps.quit", {
      bundleId,
    });
    const parsed = QUIT_APP_SCHEMA.safeParse(result);
    return parsed.success && parsed.data.asked;
  } catch (err) {
    log.warn(
      `[helper] quit app failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

/** The bundle identifier of the application in front, or `null` when the helper cannot say. */
const frontmostApp = async (): Promise<string | null> => {
  try {
    const result = await getSharedHelperClient().call("apps.frontmost");
    const parsed = FRONTMOST_APP_SCHEMA.safeParse(result);
    return parsed.success ? parsed.data.bundleId : null;
  } catch (err) {
    log.warn(
      `[helper] frontmost app query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
};

/**
 * Whether the renderer has asked for the input watch, so a helper that comes
 * back from a crash is put back to watching. The renderer asks once and is
 * not told about the restart, and a watch that silently stopped would let an
 * offer outlive the edit it means to replace.
 */
let desiredInputActivityWatch = false;

const setInputActivityWatch = async (enable: boolean): Promise<boolean> => {
  desiredInputActivityWatch = enable;
  return sendInputActivityWatch(enable);
};

const sendInputActivityWatch = async (enable: boolean): Promise<boolean> => {
  try {
    const result = await getSharedHelperClient().call(
      "input.setActivityWatch",
      {
        enable,
      },
    );
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    return parsed.success && parsed.data.enabled === enable;
  } catch (err) {
    log.warn(
      `[helper] input activity watch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

/**
 * Ask the helper to report the end of the scroll the watch frame stepped
 * aside for. Wanted-or-not lives in the shell's watch state, so a helper
 * that comes back from a crash is put back to watching the same way the
 * activity watch is.
 */
const sendScrollWatch = async (enable: boolean): Promise<boolean> => {
  try {
    const result = await getSharedHelperClient().call("input.setScrollWatch", {
      enable,
    });
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    return parsed.success && parsed.data.enabled === enable;
  } catch (err) {
    log.warn(
      `[helper] scroll watch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

/**
 * Ask the helper to report the next press on something the assistant is
 * pointing at, or to stop when there is nothing. Wanted-or-not lives in the
 * shell's watch state, so a helper that comes back from a crash is put back
 * to watching the same rectangles.
 */
const sendPressWatch = async (
  rects: readonly HelperHotkeyPressRect[],
): Promise<boolean> => {
  try {
    const result = await getSharedHelperClient().call("input.setPressWatch", {
      rects,
    });
    const parsed = HOTKEY_RESULT_SCHEMA.safeParse(result);
    return parsed.success && parsed.data.enabled === rects.length > 0;
  } catch (err) {
    log.warn(
      `[helper] press watch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

const INPUT_PRESSED_SCHEMA = z.object({
  index: z.number().int().nonnegative(),
});

/**
 * What the helper can say about where a paste to the application in front
 * would land.
 *
 * `takesText` is true on every answer but a confident no. A helper that is
 * not running, not trusted, or slow to answer cannot see a text field that is
 * genuinely there, and the cost of the two mistakes is not the same:
 * withholding a paste that would have worked breaks dictation into that
 * application, where sending one that lands nowhere is caught downstream and
 * the words are offered instead.
 *
 * `helperAnswered` says whether the helper replied at all, so the paste that
 * follows knows whether the helper can be asked to send it.
 */
export type FrontAppFocus = { takesText: boolean; helperAnswered: boolean };

export const readFrontAppFocus = async (): Promise<FrontAppFocus> => {
  try {
    const result = await getSharedHelperClient().call("focus.read");
    const parsed = FRONT_FOCUS_SCHEMA.safeParse(result);
    if (!parsed.success) {
      log.warn("[helper] focus read returned an invalid result");
      return { takesText: true, helperAnswered: false };
    }
    return { takesText: parsed.data.takesText, helperAnswered: true };
  } catch (err) {
    log.warn(
      `[helper] focus read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { takesText: true, helperAnswered: false };
  }
};

const FRONT_SHORTCUT_SCHEMA = z.object({
  outcome: z.enum(["posted", "untrusted", "noFrontApp", "failed"]),
});

/**
 * Whether the helper sent a shortcut: `posted`; `declined` when it is certain
 * nothing went (no helper to ask, the helper refused the call, or it said it
 * did not post); `unknown` when the call was lost after it went out, which
 * may have been after the keystroke did.
 */
export type ShortcutOutcome = "posted" | "declined" | "unknown";

/** Send Command plus `key` to the application in front, from the helper. */
export const postFrontAppShortcut = async (
  key: "v" | "z",
): Promise<ShortcutOutcome> => {
  let pending: Promise<unknown>;
  try {
    pending = getSharedHelperClient().call("keys.shortcut", { key });
  } catch (err) {
    log.warn(
      `[helper] shortcut not sent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "declined";
  }
  try {
    const parsed = FRONT_SHORTCUT_SCHEMA.safeParse(await pending);
    if (!parsed.success) {
      log.warn("[helper] shortcut returned an invalid result");
      return "unknown";
    }
    if (parsed.data.outcome !== "posted") {
      log.warn(
        `[helper] shortcut cmd+${key} not posted: ${parsed.data.outcome}`,
      );
      return "declined";
    }
    return "posted";
  } catch (err) {
    log.warn(
      `[helper] shortcut failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // An error the helper sent back means the handler refused the call before
    // posting anything. Anything else lost the reply, not the request.
    return err instanceof JsonRpcHelperError ? "declined" : "unknown";
  }
};

interface HotkeyOwner {
  webContents: WebContents;
  cleanup: () => void;
}

const MODIFIER_HOLD_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({
    kind: z.literal("modifierOnly"),
    modifiers: z
      .array(z.enum(["function", "control", "shift", "option", "command"]))
      .min(1),
  }),
]);

/**
 * Bounded on both arms: a binding names a shortcut, and one asking for a
 * dozen keys under four modifiers is asking to take a share of the keyboard
 * rather than to bind a gesture.
 */
const CHORD_BINDING_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({
    kind: z.literal("chord"),
    modifiers: z
      .array(z.enum(["function", "control", "shift", "option", "command"]))
      .min(1)
      .max(3),
    // Single characters: a key is named by the character on its cap, and the
    // helper resolves a press through the layout before matching.
    keys: z.array(z.string().length(1)).min(1).max(8),
  }),
]);

const hotkeyOwners = new Map<number, HotkeyOwner>();
let activeHotkeyOwnerId: number | null = null;
/** Whether the running helper has taken the binding, as far as main knows. */
let helperHoldsBinding = false;
/** Whether the helper that comes back next is owed the binding it died with. */
let restoreHoldAfterRestart = false;
let restoreHoldInFlight = false;
let holdIsOpen = false;

const newestOwnerId = (): number | null => {
  let id: number | null = null;
  for (const [ownerId, owner] of hotkeyOwners) {
    if (!owner.webContents.isDestroyed()) id = ownerId;
  }
  return id;
};

const removeHotkeyOwner = (webContentsId: number): void => {
  const owner = hotkeyOwners.get(webContentsId);
  if (!owner) return;
  owner.cleanup();
  hotkeyOwners.delete(webContentsId);
  if (activeHotkeyOwnerId === webContentsId) {
    activeHotkeyOwnerId = newestOwnerId();
  }
};

const releaseHotkeyOwner = (webContents: WebContents): void => {
  removeHotkeyOwner(webContents.id);

  if (hotkeyOwners.size === 0) {
    // Nothing is left to receive the edges, so a hold still armed in the
    // helper would open a microphone into a window that is gone.
    void setModifierHold({ kind: "off" });
  }
};

const addHotkeyOwner = (webContents: WebContents): void => {
  const id = webContents.id;
  if (hotkeyOwners.has(id)) {
    activeHotkeyOwnerId = id;
    return;
  }

  const win = BrowserWindow.fromWebContents(webContents);
  const markActive = () => {
    if (hotkeyOwners.has(id)) activeHotkeyOwnerId = id;
  };
  const handleDestroyed = () => {
    releaseHotkeyOwner(webContents);
  };

  webContents.once("destroyed", handleDestroyed);
  win?.on("focus", markActive);

  hotkeyOwners.set(id, {
    webContents,
    cleanup: () => {
      webContents.off("destroyed", handleDestroyed);
      win?.off("focus", markActive);
    },
  });
  activeHotkeyOwnerId = id;
};

/** The window the key's events go to: the active owner, else the newest live one. */
const hotkeyOwnerTarget = (): WebContents | null => {
  const ownerId = activeHotkeyOwnerId ?? newestOwnerId();
  const activeOwner = ownerId !== null ? hotkeyOwners.get(ownerId) : null;
  const owner =
    activeOwner && !activeOwner.webContents.isDestroyed()
      ? activeOwner
      : hotkeyOwners.get(newestOwnerId() ?? -1);
  if (!owner || owner.webContents.isDestroyed()) return null;
  return owner.webContents;
};

const sendHotkeyEventToOwner = (event: HotkeyEvent): void => {
  // A chord belongs to the window that armed it, and to no other. Dropped
  // rather than redirected when that window has gone: the press asked
  // something of a session that went with it.
  if (event.kind === "chord") {
    if (chordOwner === null || chordOwner.isDestroyed()) {
      return;
    }
    chordOwner.send("cadet:helper:hotkey:event", event);
    return;
  }
  holdIsOpen = event.state === "down";
  hotkeyOwnerTarget()?.send("cadet:helper:hotkey:event", event);
};

const sendInputActivityToOwner = (): void => {
  // A press on the companion is a press on Cadet's own controls: the offer
  // those controls answer must not be taken down by the click answering it.
  if (isPointerOnCompanion()) {
    return;
  }
  hotkeyOwnerTarget()?.send(HELPER_INPUT_ACTIVITY_EVENT);
};

/**
 * Close the hold the dead helper left open. Its consumer is a microphone that
 * closes on the `up`, and the edge has to say the user did not let go.
 */
const sendSyntheticHotkeyUpIfNeeded = (): void => {
  if (!holdIsOpen) {
    return;
  }
  holdIsOpen = false;
  sendHotkeyEventToOwner({
    kind: "modifierHold",
    state: "up",
    reason: "cancelled",
  });
};

/**
 * Hand a helper that has just come back the binding the app believes it holds.
 * The renderer registered once and is not told about the restart, so without
 * this the key is dead until the next reload.
 */
const restoreModifierHoldIfNeeded = async (): Promise<void> => {
  if (
    !restoreHoldAfterRestart ||
    restoreHoldInFlight ||
    modifierHoldBinding.kind === "off" ||
    hotkeyOwners.size === 0
  ) {
    return;
  }

  restoreHoldInFlight = true;
  const result = await sendModifierHold(modifierHoldBinding);
  restoreHoldInFlight = false;
  if (result.ok && result.enabled) {
    restoreHoldAfterRestart = false;
    log.info("[helper] restored the voice key after helper restart");
  } else {
    log.warn(
      `[helper] failed to restore the voice key: ${result.ok ? "helper refused" : result.reason}`,
    );
  }
};

const restoreChordsIfNeeded = async (): Promise<void> => {
  if (
    !restoreChordsAfterRestart ||
    chordBinding.kind === "off" ||
    chordOwner === null ||
    chordOwner.isDestroyed()
  ) {
    return;
  }
  const result = await sendChords(chordBinding);
  if (result.ok && result.enabled) {
    restoreChordsAfterRestart = false;
    log.info("[helper] restored the call's chords after helper restart");
  }
};

const handleHelperState = (state: { status: string }): void => {
  if (state.status === "running") {
    void restoreModifierHoldIfNeeded();
    void restoreChordsIfNeeded();
    // The watch went down with the helper the binding did, and the renderer
    // asks for neither again. Restored beside the binding rather than behind
    // it: they are two registrations, and an offer outliving the edit it
    // means to replace must not wait on a hold's round trip.
    if (desiredInputActivityWatch) {
      void sendInputActivityWatch(true);
    }
    if (shellWatches?.isFrameScrollWatched()) {
      void sendScrollWatch(true);
    }
    const pressRects = shellWatches?.watchedCoachmarkPress() ?? null;
    if (pressRects !== null) {
      void sendPressWatch(pressRects);
    }
    return;
  }

  if (helperHoldsBinding) {
    helperHoldsBinding = false;
    restoreHoldAfterRestart = true;
  }
  if (chordBinding.kind !== "off") {
    restoreChordsAfterRestart = true;
  }
  sendSyntheticHotkeyUpIfNeeded();
};

let installed = false;
let shellWatches: HelperHotkeysWatches | null = null;
let unsubscribeHotkeyEvents: (() => void) | null = null;
let unsubscribeInputActivity: (() => void) | null = null;
let unsubscribeScrollEnded: (() => void) | null = null;
let unsubscribePressed: (() => void) | null = null;
let unsubscribeState: (() => void) | null = null;

/**
 * Install the helper's hotkey family: the voice key's hold and chords, the
 * front-application reads the words ride, and the input watches. The
 * bindings, owners, and restores are the same over any helper that speaks
 * the protocol; the watch state and the companion check are this feature's
 * own modules beside it.
 */
export const install = (): void => {
  if (installed) return;
  installed = true;
  shellWatches = {
    provideFrameScrollWatch,
    frameScrollEnded,
    isFrameScrollWatched,
    provideCoachmarkPressWatch,
    coachmarkPressed,
    watchedCoachmarkPress,
  };

  unsubscribeState = getSharedHelperClient().onState(handleHelperState);
  unsubscribeHotkeyEvents = getSharedHelperClient().onNotification(
    "hotkey.event",
    HOTKEY_EVENT_SCHEMA,
    (event) => {
      sendHotkeyEventToOwner(event);
    },
  );
  unsubscribeInputActivity = getSharedHelperClient().onNotification(
    "input.activity",
    z.unknown(),
    () => {
      sendInputActivityToOwner();
    },
  );
  unsubscribeScrollEnded = getSharedHelperClient().onNotification(
    "input.scrollEnded",
    z.unknown(),
    () => {
      shellWatches?.frameScrollEnded();
    },
  );
  shellWatches?.provideFrameScrollWatch((enable) => {
    void sendScrollWatch(enable);
  });
  unsubscribePressed = getSharedHelperClient().onNotification(
    "input.pressed",
    INPUT_PRESSED_SCHEMA,
    (event) => {
      shellWatches?.coachmarkPressed(event.index);
    },
  );
  shellWatches?.provideCoachmarkPressWatch((rects) => {
    void sendPressWatch(rects);
  });
  handle(
    HELPER_HOTKEY_SET_MODIFIER_HOLD,
    z.tuple([MODIFIER_HOLD_SCHEMA]),
    ([hold], event) => {
      // The edges reach whichever window asked for the binding: a microphone
      // bracketed by them belongs to the window that opened it. Clearing the
      // binding leaves the ownership alone, since the window may be about to
      // register another.
      if (hold.kind !== "off") {
        // The binding is inert without Input Monitoring. The renderer asks for
        // the grant when it arms the key; a press cannot be the moment, since
        // noticing the press is the thing being asked for.
        addHotkeyOwner(event.sender);
      }
      return setModifierHold(hold);
    },
  );

  handle(
    HELPER_HOTKEY_SET_CHORDS,
    z.tuple([CHORD_BINDING_SCHEMA]),
    ([binding], event) => {
      // Registered by the window that can answer them, which is where the
      // events go. A clear from any window clears the binding, since the only
      // window that arms it is the one that would.
      return setChords(binding, binding.kind === "off" ? null : event.sender);
    },
  );

  handle(HELPER_HOTKEY_READ_FRONT_SELECTION, z.tuple([]), () =>
    readFrontSelection(),
  );

  handle(HELPER_APPS_RUNNING, z.tuple([z.array(z.string()).max(32)]), ([ids]) =>
    runningApps(ids),
  );
  handle(HELPER_APPS_QUIT, z.tuple([z.string().max(255)]), ([bundleId]) =>
    quitApp(bundleId),
  );
  handle(HELPER_APPS_FRONTMOST, z.tuple([]), () => frontmostApp());
  handle(HELPER_INPUT_SET_ACTIVITY_WATCH, z.tuple([z.boolean()]), ([enable]) =>
    setInputActivityWatch(enable),
  );
};

export const __resetForTesting = (): void => {
  installed = false;
  shellWatches = null;
  modifierHoldBinding = { kind: "off" };
  desiredModifierHold = { kind: "off" };
  modifierHoldInFlight = null;
  helperHoldsBinding = false;
  restoreHoldAfterRestart = false;
  releaseChordOwner?.();
  releaseChordOwner = null;
  chordBinding = { kind: "off" };
  chordOwner = null;
  restoreChordsAfterRestart = false;
  restoreHoldInFlight = false;
  desiredInputActivityWatch = false;
  holdIsOpen = false;
  unsubscribeState?.();
  unsubscribeState = null;
  unsubscribeHotkeyEvents?.();
  unsubscribeHotkeyEvents = null;
  unsubscribeInputActivity?.();
  unsubscribeInputActivity = null;
  unsubscribeScrollEnded?.();
  unsubscribeScrollEnded = null;
  unsubscribePressed?.();
  unsubscribePressed = null;
  for (const owner of hotkeyOwners.values()) owner.cleanup();
  hotkeyOwners.clear();
  activeHotkeyOwnerId = null;
};
