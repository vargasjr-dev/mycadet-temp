import { writeFile } from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, dialog } from "electron";
import { z } from "zod";

import { handle } from "../ipc";

/**
 * `share.shareFile(bytes, filename)` for the classic-desktop shells. Neither
 * has an app-invokable equivalent of the macOS share sheet, so the committed
 * contract is served by the documented export fallback: a native Save As
 * dialog anchored to the sender's window, writing the bytes directly to the
 * picked destination (no staged temp files). Cancelling resolves without
 * writing, matching the macOS dismissed picker.
 */

const ShareFileArgs = z.tuple([z.instanceof(Uint8Array), z.string().min(1)]);

// Characters invalid in common filenames on either desktop, plus separators
// and control characters.
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export const sanitizeFilename = (filename: string): string => {
  // The platform's own basename rules strip both separator styles on the
  // hosts these shells ship to, so a download that survived a web filename
  // still lands on a single flat name here.
  const basename =
    process.platform === "win32" ? path.win32.basename : path.posix.basename;
  const base = basename(filename).replace(INVALID_FILENAME_CHARS, "_");
  return base.length > 0 ? base : "download";
};

export const install = (): void => {
  handle(
    "cadet:share:file",
    ShareFileArgs,
    async ([bytes, filename], event): Promise<void> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = { defaultPath: sanitizeFilename(filename) };
      const { canceled, filePath } = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (canceled || !filePath) {
        return;
      }
      await writeFile(filePath, bytes);
    },
  );
};
