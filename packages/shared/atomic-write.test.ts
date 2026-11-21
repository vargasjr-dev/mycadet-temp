import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

import { writeFileAtomic } from "./atomic-write.js";

describe("writeFileAtomic", () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-atomic-write-"));
  const target = join(dir, "target.json");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the renamed file carries the full contents", () => {
    writeFileAtomic(target, '{"a":1}\n');
    expect(readFileSync(target, "utf-8")).toBe('{"a":1}\n');
  });

  test("a second write replaces the first in place", () => {
    writeFileAtomic(target, '{"b":2}\n');
    expect(readFileSync(target, "utf-8")).toBe('{"b":2}\n');
  });

  test("a failed write leaves the previous file intact and sweeps the temp", () => {
    writeFileAtomic(target, '{"keep":true}\n');
    // A directory parked at the temp path makes the write fail
    // deterministically — the real filesystem, no mocks.
    const tempPath = `${target}.tmp.${process.pid}`;
    mkdirSync(tempPath);
    try {
      expect(() => writeFileAtomic(target, '{"nope":1}\n')).toThrow();
      expect(readFileSync(target, "utf-8")).toBe('{"keep":true}\n');
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
    expect(existsSync(tempPath)).toBe(false);
  });

  test("the mode option rides the rename onto the target", () => {
    const scoped = join(dir, "scoped.json");
    writeFileAtomic(scoped, "{}\n", { mode: 0o600 });
    expect((statSync(scoped).mode & 0o777).toString(8)).toBe("600");
  });

  test("no temp litter survives a successful write", () => {
    writeFileSync(join(dir, "probe.txt"), "x");
    writeFileAtomic(join(dir, "litter.json"), "hi");
    expect(existsSync(`${join(dir, "litter.json")}.tmp.${process.pid}`)).toBe(
      false,
    );
  });
});
