import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowserWindow, dialog, type WebContents } from "electron";
import { z } from "zod";

import { handle } from "../ipc";

/**
 * `share.shareFile(bytes, filename)` for every desktop shell. The shell
 * decides what presenting a shared file means:
 *
 * - The classic shells have no app-invokable share surface, so the
 *   committed contract is served by the documented export fallback: a
 *   native Save As dialog anchored to the sender's window, writing the
 *   bytes directly to the picked destination (no staged temp files).
 *   Cancelling resolves without writing.
 *
 * - A shell with a native share surface passes a `present` callback and
 *   receives a staged temp file instead. The staging exists because that
 *   kind of picker shares files by path. Cleanup is deliberately NOT tied
 *   to the picker closing: a picker's close callback fires the moment a
 *   service is *selected*, not when the selected service has finished with
 *   the file — an in-flight transfer can still read it after the menu
 *   closes, so deleting there could pull it out from under the share.
 *   Instead the sweep reclaims only *stale* staged dirs, ones old enough
 *   that no transfer could still be using them, at startup and before each
 *   new share. Bounding to stale dirs also keeps the sweep safe when a
 *   second build of the app is sharing concurrently.
 */

const SHARE_TMP_PREFIX = "cadet-share-";

// A staged dir older than this can't belong to an in-flight share — even a
// large transfer over a slow link finishes well within an hour — so it's
// safe to reclaim. Anything newer might still be open by the selected
// service (or by a second build sharing at the same time), so it's left
// alone.
const SHARE_TMP_STALE_MS = 60 * 60 * 1000;

const ShareFileArgs = z.tuple([z.instanceof(Uint8Array), z.string().min(1)]);

/** What presenting a staged shared file means, per shell. */
export type SharePresenter = (file: {
  filePath: string;
  sender: WebContents;
}) => Promise<void> | void;

/**
 * Reclaim *stale* staged share dirs — those older than `SHARE_TMP_STALE_MS`.
 * Bounded to old dirs so it never deletes a file this run (or a concurrent
 * build) still has open for an in-flight share. Exported for unit tests.
 */
export const sweepStaleShareDirs = async (): Promise<void> => {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.startsWith(SHARE_TMP_PREFIX))
      .map(async (name) => {
        const dir = path.join(root, name);
        try {
          const { mtimeMs } = await stat(dir);
          if (now - mtimeMs >= SHARE_TMP_STALE_MS) {
            await rm(dir, { recursive: true, force: true });
          }
        } catch {
          // Raced with another sweep, or already gone — ignore.
        }
      }),
  );
};

// Characters invalid in common filenames on any desktop, plus separators
// and control characters.
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export const sanitizeFilename = (filename: string): string => {
  // The host's own basename rules strip both separator styles, so a
  // download that survived a web filename still lands on a single flat
  // name here.
  const base = path.basename(filename).replace(INVALID_FILENAME_CHARS, "_");
  return base.length > 0 ? base : "download";
};

export const install = (share?: { present: SharePresenter }): void => {
  if (share) {
    // Reclaim stale staged files an earlier run left behind (crash /
    // force-quit). A shell without staging never creates them, so the
    // sweep is a cheap no-op there — but it stays on for symmetry of the
    // one install path.
    void sweepStaleShareDirs();
  }

  handle(
    "cadet:share:file",
    ShareFileArgs,
    async ([bytes, filename], event): Promise<void> => {
      if (share) {
        // Opportunistically reclaim old shares so temp usage stays bounded
        // without an unsafe close-time delete. Fire-and-forget — it never
        // blocks the share, and the staleness filter keeps it off the file
        // we're about to write (and off any concurrent share).
        void sweepStaleShareDirs();

        const dir = await mkdtemp(path.join(tmpdir(), SHARE_TMP_PREFIX));
        // `basename` strips any path components the renderer's filename may
        // carry, keeping the write inside the temp dir.
        const filePath = path.join(dir, path.basename(filename));
        await writeFile(filePath, bytes);
        await share.present({ filePath, sender: event.sender });
        return;
      }

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
