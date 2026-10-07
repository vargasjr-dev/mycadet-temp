/**
 * Runtime wrapper for the standalone Electron command palette window.
 *
 * New Electron shells expose `window.cadet.commandPalette`; web/iOS and
 * older Electron shells do not. `openCommandPaletteWindow` returns whether
 * the host handled the request so callers can fall back to the in-page
 * palette without probing `window.cadet` themselves.
 */

import { isElectron, type CadetCommand } from "@/runtime/is-electron";

export async function openCommandPaletteWindow(): Promise<boolean> {
  if (!isElectron()) {
    return false;
  }
  const open = window.cadet?.commandPalette?.open;
  if (!open) {
    return false;
  }
  await open();
  return true;
}

export async function dismissCommandPaletteWindow(): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.cadet?.commandPalette?.dismiss();
}

export async function selectCommandPaletteCommand(
  command: CadetCommand,
): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.cadet?.commandPalette?.select(command);
}
