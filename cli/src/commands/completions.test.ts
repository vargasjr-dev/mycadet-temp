import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { saveLockfileAssistant } from "../lib/assistant-config.js";
import { completeCadet } from "./completions.js";

const COMMAND_NAMES = [
  "backup",
  "clean",
  "client",
  "completions",
  "confirm",
  "connect",
  "hatch",
  "ps",
  "retire",
  "sleep",
  "use",
  "wake",
];

describe("completeCadet", () => {
  let lockfileDir: string;
  let prevLockfileDir: string | undefined;

  beforeEach(() => {
    lockfileDir = mkdtempSync(join(tmpdir(), "cadet-completions-"));
    prevLockfileDir = process.env.CADET_LOCKFILE_DIR;
    process.env.CADET_LOCKFILE_DIR = lockfileDir;
  });

  afterEach(() => {
    if (prevLockfileDir === undefined) delete process.env.CADET_LOCKFILE_DIR;
    else process.env.CADET_LOCKFILE_DIR = prevLockfileDir;
    rmSync(lockfileDir, { recursive: true, force: true });
  });

  function seed(id: string): void {
    saveLockfileAssistant({
      assistantId: id,
      cloud: "docker",
      runtimeUrl: "http://localhost:7830",
      hatchedAt: new Date().toISOString(),
    });
  }

  test("no words yet offers every command name, sorted", () => {
    const input: string[] = [];
    expect(completeCadet(input, COMMAND_NAMES)).toEqual(
      [...COMMAND_NAMES].sort(),
    );
    // The word under the cursor is popped from a COPY — the caller's array
    // (bash's COMP_WORDS) must come back untouched.
    expect(input).toEqual([]);
  });

  test("first positional of an assistant-name command offers known assistant names", () => {
    seed("quill-owl-d4e5f6");
    seed("fable-fox-a1b2c3");
    // `cadet retire <TAB>` — the empty trailing word is the word being completed.
    expect(completeCadet(["retire", ""], COMMAND_NAMES)).toEqual([
      "fable-fox-a1b2c3",
      "quill-owl-d4e5f6",
    ]);
  });

  test("partial words are returned unfiltered — the shell does prefix filtering", () => {
    seed("quill-owl-d4e5f6");
    seed("fable-fox-a1b2c3");
    expect(completeCadet(["retire", "fable"], COMMAND_NAMES)).toEqual([
      "fable-fox-a1b2c3",
      "quill-owl-d4e5f6",
    ]);
  });

  test("flag prefixes fall through to the shell default (no candidates)", () => {
    seed("fable-fox-a1b2c3");
    expect(completeCadet(["retire", "--"], COMMAND_NAMES)).toEqual([]);
    expect(completeCadet(["retire", "--name"], COMMAND_NAMES)).toEqual([]);
  });

  test("deeper positionals of an assistant-name command offer nothing", () => {
    seed("fable-fox-a1b2c3");
    expect(
      completeCadet(["exec", "fable-fox-a1b2c3", ""], COMMAND_NAMES),
    ).toEqual([]);
    expect(
      completeCadet(["logs", "fable-fox-a1b2c3", "tail", ""], COMMAND_NAMES),
    ).toEqual([]);
  });

  test("commands that take no assistant name offer nothing after the command word", () => {
    seed("fable-fox-a1b2c3");
    expect(completeCadet(["hatch", ""], COMMAND_NAMES)).toEqual([]);
    expect(completeCadet(["ps", ""], COMMAND_NAMES)).toEqual([]);
  });

  test("an unreadable/empty lockfile completes quietly with no names", () => {
    // No entries seeded — the lockfile dir exists but has no lockfile.json.
    expect(completeCadet(["retire", ""], COMMAND_NAMES)).toEqual([]);
  });
});
