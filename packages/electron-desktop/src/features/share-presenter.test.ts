import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test-setup";
import { tmpdir } from "node:os";
import path from "node:path";

import type { z } from "zod";

// Capture the invocable IPC registration `install` makes so the tests can
// drive the handler directly without a real `ipcMain`. The sender-origin guard
// inside the real `handle` is covered by the ipc suite, so it's intentionally
// absent here.
type Handler = (args: unknown[], event: unknown) => unknown;
type Registration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: Handler;
};
const handleRegistrations: Registration[] = [];
mock.module("../ipc", () => ({
  handle: (channel: string, schema: z.ZodType<unknown[]>, fn: Handler) => {
    handleRegistrations.push({ channel, schema, fn });
  },
}));

// `node:fs/promises` is mocked so the temp-file dance and the stale-dir sweep
// are asserted structurally — no real disk access. `node:os` / `node:path`
// stay real (pure helpers), so the asserted paths match what production builds.
const mkdtempMock = mock((prefix: string) =>
  Promise.resolve(`${prefix}abc123`),
);
const writeFileMock = mock((_path: string, _data: unknown) =>
  Promise.resolve(),
);
const readdirMock = mock((_path: string) => Promise.resolve<string[]>([]));
const rmMock = mock((_path: string, _opts: unknown) => Promise.resolve());
const statMock = mock((_path: string) => Promise.resolve({ mtimeMs: 0 }));
mock.module("node:fs/promises", () => ({
  mkdtemp: mkdtempMock,
  writeFile: writeFileMock,
  readdir: readdirMock,
  rm: rmMock,
  stat: statMock,
}));

mock.module("electron", () => electronMock({}));

const { install, sweepStaleShareDirs } = await import("./share");

// The test's stand-in for a shell's native share surface: it records what
// the staged share handed it.
const presented: Array<{ filePath: string; sender: unknown }> = [];
const present = (file: { filePath: string; sender: unknown }): void => {
  presented.push(file);
};

install({ present });

// install kicks off a startup sweep (a `readdir`) synchronously; snapshot the
// call count before `beforeEach` clears the mocks.
const readdirCallsAtInstall = readdirMock.mock.calls.length;

const shareReg = (): Registration =>
  handleRegistrations.find((r) => r.channel === "cadet:share:file")!;

// A stand-in for `IpcMainInvokeEvent` — the handler only reads `.sender`.
const fakeSender = { id: 1 };
const fakeEvent = { sender: fakeSender };

const bytes = new Uint8Array([1, 2, 3, 4]);
const expectedDir = `${path.join(tmpdir(), "cadet-share-")}abc123`;
const STALE_MS = 60 * 60 * 1000;

beforeEach(() => {
  presented.length = 0;
  mkdtempMock.mockClear();
  writeFileMock.mockClear();
  rmMock.mockClear();
  readdirMock.mockReset();
  readdirMock.mockReturnValue(Promise.resolve<string[]>([]));
  statMock.mockReset();
  statMock.mockImplementation((_path: string) =>
    Promise.resolve({ mtimeMs: Date.now() }),
  );
});

describe("install wiring", () => {
  test("registers cadet:share:file exactly once over the invocable `handle` path", () => {
    const matches = handleRegistrations.filter(
      (r) => r.channel === "cadet:share:file",
    );
    expect(matches).toHaveLength(1);
  });

  test("kicks off a single startup sweep for a shell with a presenter", () => {
    expect(readdirCallsAtInstall).toBe(1);
  });
});

describe("ShareFileArgs schema", () => {
  test("accepts a [Uint8Array, non-empty string] tuple", () => {
    expect(shareReg().schema.safeParse([bytes, "report.pdf"]).success).toBe(
      true,
    );
  });

  test("rejects an empty filename", () => {
    expect(shareReg().schema.safeParse([bytes, ""]).success).toBe(false);
  });

  test("rejects wrong types, missing args, and extra args", () => {
    const schema = shareReg().schema;
    expect(schema.safeParse(["not-bytes", "report.pdf"]).success).toBe(false);
    expect(schema.safeParse([bytes]).success).toBe(false);
    expect(schema.safeParse([bytes, 42]).success).toBe(false);
    expect(schema.safeParse([bytes, "report.pdf", "extra"]).success).toBe(
      false,
    );
    expect(schema.safeParse([]).success).toBe(false);
  });
});

describe("staged share handler", () => {
  test("writes the bytes to a fresh temp file and hands the presenter that path", async () => {
    // WHEN the renderer shares a file
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // THEN the bytes are written under a throwaway temp dir…
    expect(mkdtempMock).toHaveBeenCalledWith(
      path.join(tmpdir(), "cadet-share-"),
    );
    const expectedPath = path.join(expectedDir, "report.pdf");
    expect(writeFileMock).toHaveBeenCalledWith(expectedPath, bytes);

    // …and the presenter is handed exactly that path, with the sender.
    expect(presented).toEqual([{ filePath: expectedPath, sender: fakeSender }]);
  });

  test("strips path components from the renderer filename, keeping the write inside the temp dir", async () => {
    // WHEN a filename carries directory traversal
    await shareReg().fn([bytes, "../../etc/passwd"], fakeEvent);

    // THEN only the basename is used, so the write stays in the temp dir
    const expectedPath = path.join(expectedDir, "passwd");
    expect(writeFileMock).toHaveBeenCalledWith(expectedPath, bytes);
    expect(presented[0]!.filePath).toBe(expectedPath);
  });

  test("never deletes the fresh temp dir — only stale dirs are swept", async () => {
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // Cleanup is intentionally NOT tied to the picker closing: a picker's
    // close callback fires the moment a service is selected, not when the
    // service is done reading the file. The just-written (fresh) dir is
    // never swept — only stale dirs are.
    expect(rmMock).not.toHaveBeenCalled();
  });
});

describe("sweepStaleShareDirs", () => {
  const dirPath = (name: string): string => path.join(tmpdir(), name);

  test("removes only stale staged dirs, sparing fresh ones and unrelated entries", async () => {
    const now = Date.now();
    const mtimes: Record<string, number> = {
      "cadet-share-old": now - 2 * STALE_MS, // stale → removed
      "cadet-share-fresh": now - 1000, // in-flight → kept
      "cadet-share-old2": now - (STALE_MS + 5000), // stale → removed
    };
    readdirMock.mockReturnValue(
      Promise.resolve([
        "cadet-share-old",
        "cadet-share-fresh",
        "cadet-unrelated-entry",
        "cadet-share-old2",
      ]),
    );
    statMock.mockImplementation((p: string) =>
      Promise.resolve({ mtimeMs: mtimes[path.basename(p)] ?? now }),
    );

    await sweepStaleShareDirs();

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(rmMock).toHaveBeenCalledWith(dirPath("cadet-share-old"), {
      recursive: true,
      force: true,
    });
    expect(rmMock).toHaveBeenCalledWith(dirPath("cadet-share-old2"), {
      recursive: true,
      force: true,
    });
    // A fresh staged dir might still be open by the selected service —
    // never deleted, even though it matches the prefix.
    expect(rmMock).not.toHaveBeenCalledWith(
      dirPath("cadet-share-fresh"),
      expect.anything(),
    );
    // Unrelated temp dirs aren't even stat'd.
    expect(statMock).not.toHaveBeenCalledWith(dirPath("cadet-unrelated-entry"));
  });

  test("leaves everything in place when no share dir is stale", async () => {
    const now = Date.now();
    readdirMock.mockReturnValue(
      Promise.resolve(["cadet-share-a", "cadet-share-b"]),
    );
    statMock.mockImplementation(() => Promise.resolve({ mtimeMs: now - 1000 }));

    await sweepStaleShareDirs();

    expect(rmMock).not.toHaveBeenCalled();
  });

  test("swallows a readdir failure without throwing or deleting", async () => {
    readdirMock.mockImplementation(() =>
      Promise.reject(new Error("tmpdir unreadable")),
    );

    await expect(sweepStaleShareDirs()).resolves.toBeUndefined();
    expect(rmMock).not.toHaveBeenCalled();
  });

  test("a stat failure on one dir doesn't block sweeping the others", async () => {
    const now = Date.now();
    readdirMock.mockReturnValue(
      Promise.resolve(["cadet-share-bad", "cadet-share-old"]),
    );
    statMock.mockImplementation((p: string) =>
      path.basename(p) === "cadet-share-bad"
        ? Promise.reject(new Error("stat failed"))
        : Promise.resolve({ mtimeMs: now - 2 * STALE_MS }),
    );

    await expect(sweepStaleShareDirs()).resolves.toBeUndefined();
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(dirPath("cadet-share-old"), {
      recursive: true,
      force: true,
    });
  });
});
