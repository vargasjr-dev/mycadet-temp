import type { TextInsertionResult as BridgeTextInsertionResult } from "@mycadet/ipc-contract";

import { isElectron } from "@/runtime/is-electron";
import { openSystemPermissionSettings } from "@/runtime/system-permissions";

export type TextInsertionResult =
  | BridgeTextInsertionResult
  | { status: "unavailable" };

export async function insertTextIntoFrontApp(
  text: string,
): Promise<TextInsertionResult> {
  if (!isElectron() || !window.cadet?.text?.insertIntoFrontApp) {
    return { status: "unavailable" };
  }

  try {
    return await window.cadet.text.insertIntoFrontApp(text);
  } catch (err) {
    console.warn("insertTextIntoFrontApp failed", err);
    return { status: "blocked" };
  }
}

/**
 * Undo the last edit in the application in front, for putting Cadet's
 * dictation in the place of one another app pasted. Unavailable off Electron.
 */
export async function undoInFrontApp(): Promise<TextInsertionResult> {
  const undo = window.cadet?.text?.undoInFrontApp;
  if (!isElectron() || typeof undo !== "function") {
    return { status: "unavailable" };
  }
  return await undo();
}

export async function openTextInsertionSettings(): Promise<void> {
  try {
    if (await openSystemPermissionSettings("automation")) {
      return;
    }
  } catch {
    // Fall through to the legacy bridge below.
  }
  if (!isElectron() || !window.cadet?.text?.openAutomationSettings) {
    return;
  }
  try {
    await window.cadet.text.openAutomationSettings();
  } catch (err) {
    console.warn("openTextInsertionSettings failed", err);
  }
}
