import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  cadetHomePath,
  ensureCadetHomeAt,
  legacyVellumHomePath,
} from "../cadet-home.js";

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "cadet-home-test-"));
}

describe("ensureCadetHomeAt", () => {
  test("fresh install: returns the .cadet path without creating anything", () => {
    const home = makeTempHome();
    const result = ensureCadetHomeAt(home);
    expect(result.dir).toBe(cadetHomePath(home));
    expect(result.origin).toBe("fresh");
    expect(existsSync(result.dir)).toBe(false);
    expect(existsSync(legacyVellumHomePath(home))).toBe(false);
  });

  test("legacy install: copies .vellum to .cadet, leaves the original intact", () => {
    const home = makeTempHome();
    const legacy = legacyVellumHomePath(home);
    mkdirSync(join(legacy, "workspace", "nested"), { recursive: true });
    writeFileSync(join(legacy, "device.json"), '{"deviceId":"legacy-id"}\n');
    writeFileSync(join(legacy, "workspace", "nested", "data.txt"), "payload");

    const result = ensureCadetHomeAt(home);
    expect(result.origin).toBe("copied");
    expect(result.dir).toBe(cadetHomePath(home));

    // Copy is complete...
    expect(readText(join(result.dir, "device.json"))).toBe(
      '{"deviceId":"legacy-id"}\n',
    );
    expect(readText(join(result.dir, "workspace", "nested", "data.txt"))).toBe(
      "payload",
    );

    // ...and copy-not-move: the legacy directory is untouched.
    expect(existsSync(join(legacy, "device.json"))).toBe(true);
    expect(existsSync(join(legacy, "workspace", "nested", "data.txt"))).toBe(
      true,
    );
  });

  test("existing .cadet wins: a legacy directory is never re-copied over it", () => {
    const home = makeTempHome();
    const legacy = legacyVellumHomePath(home);
    const cadet = cadetHomePath(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(cadet, { recursive: true });
    writeFileSync(join(legacy, "new.txt"), "from-legacy");
    writeFileSync(join(cadet, "state.txt"), "already-migrated");

    const result = ensureCadetHomeAt(home);
    expect(result.origin).toBe("existing");
    expect(existsSync(join(cadet, "new.txt"))).toBe(false);
    expect(readText(join(cadet, "state.txt"))).toBe("already-migrated");
  });

  test("is idempotent: second run does not disturb migrated state", () => {
    const home = makeTempHome();
    mkdirSync(legacyVellumHomePath(home), { recursive: true });
    writeFileSync(join(legacyVellumHomePath(home), "a.txt"), "1");

    const first = ensureCadetHomeAt(home);
    expect(first.origin).toBe("copied");
    // Simulate the install writing new state post-migration.
    writeFileSync(join(first.dir, "b.txt"), "2");

    const second = ensureCadetHomeAt(home);
    expect(second.origin).toBe("existing");
    expect(second.dir).toBe(first.dir);
    expect(readText(join(second.dir, "b.txt"))).toBe("2");
  });

  test("copy failure falls back to the legacy directory", () => {
    const home = makeTempHome();
    const legacy = legacyVellumHomePath(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "keep.txt"), "intact");

    const result = ensureCadetHomeAt(home, {
      copyDir: () => {
        throw new Error("disk full");
      },
    });
    expect(result.origin).toBe("legacy-fallback");
    expect(result.dir).toBe(legacy);
    // The install keeps working against the legacy directory.
    expect(readText(join(legacy, "keep.txt"))).toBe("intact");
    expect(existsSync(cadetHomePath(home))).toBe(false);
  });

  test("lost rename race (another process finished first) resolves to the winner", () => {
    const home = makeTempHome();
    const legacy = legacyVellumHomePath(home);
    const cadet = cadetHomePath(home);
    mkdirSync(legacy, { recursive: true });

    const result = ensureCadetHomeAt(home, {
      copyDir: (from, to) => {
        cpSync(from, to, { recursive: true });
        // Simulate a concurrent process completing the rename between our
        // copy and ours: pre-place the target so renameSync must fail.
        if (!existsSync(cadet)) {
          mkdirSync(cadet, { recursive: true });
          writeFileSync(join(cadet, "raced.txt"), "other-process");
        }
      },
    });
    expect(result.dir).toBe(cadet);
    expect(result.origin).toBe("existing");
    expect(readText(join(cadet, "raced.txt"))).toBe("other-process");
  });
});

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}
