import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../lib/assistant-config.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import * as localMode from "@mycadet/local-mode";
import * as backups from "../lib/backup-ops.js";
import * as guardian from "../lib/guardian-token.js";
import { stageRootArchive, STATE_ROOTS } from "../lib/root-backup.js";

const directory = await mkdtemp(join(tmpdir(), "safety-root-backup-"));
const root = join(directory, "instance");
const backupDir = join(directory, "backups");
const entry: LockfileAssistant = {
  assistantId: "alpha",
  cloud: "local",
  instanceDir: root,
  port: 2,
};
mkdirSync(join(root, "gateway-security"), { recursive: true });
writeFileSync(
  join(root, "gateway-security", "actor-token-signing-key"),
  Buffer.from("07".repeat(32), "hex"),
);
const lookup = spyOn(config, "findAssistantByName").mockReturnValue(entry);
const location = spyOn(backups, "getBackupsDir").mockReturnValue(backupDir);
const save = spyOn(localMode, "saveLockfileAssistant").mockImplementation(
  () => ({ ok: true, lockfile: { assistants: [] } as never }),
);
const tokens = spyOn(guardian, "loadGuardianToken").mockImplementation(() => {
  throw new Error("no guardian token access allowed");
});
beforeEach(async () => {
  for (const name of STATE_ROOTS)
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, "workspace", "notes"), "original");
  await writeFile(join(root, "gateway-security", "trust"), "gateway trust");
  await writeFile(join(root, "ces-security", "keys.enc"), "opaque ciphertext", {
    mode: 0o600,
  });
  await writeFile(join(root, "ces-data", "grants"), "CES policy");
  lookup.mockReturnValue(entry);
  tokens.mockClear();
});
afterAll(async () => {
  for (const spy of [lookup, location, save, tokens]) spy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

test("pre-upgrade safety backup captures all roots in XDG without a guardian token", async () => {
  const path = await backups.createBackup(entry.assistantId, {
    prefix: "alpha-pre-upgrade",
  });
  expect(path).toMatch(
    new RegExp(`^${backupDir}/alpha-pre-upgrade-.*\\.tar\\.gz$`),
  );
  const stage = await stageRootArchive(path!, directory);
  for (const name of STATE_ROOTS)
    expect(await readdir(join(stage, "state", name))).not.toHaveLength(0);
  expect(
    await readFile(join(stage, "state", "ces-security", "keys.enc"), "utf8"),
  ).toBe("opaque ciphertext");
  expect(tokens).not.toHaveBeenCalled();
});

test("rollback restores gateway and CES state as well as workspace", async () => {
  const path = await backups.createBackup(entry.assistantId, {
    prefix: "alpha-pre-rollback",
  });
  for (const name of STATE_ROOTS)
    await writeFile(join(root, name, "after-upgrade"), "stale");
  await writeFile(join(root, "workspace", "notes"), "modified");
  expect(
    await backups.restoreBackup(entry.assistantId, path!, {
      resume: false,
    }),
  ).toBe(true);
  expect(await readFile(join(root, "workspace", "notes"), "utf8")).toBe(
    "original",
  );
  expect(await readFile(join(root, "gateway-security", "trust"), "utf8")).toBe(
    "gateway trust",
  );
  expect(await readFile(join(root, "ces-data", "grants"), "utf8")).toBe(
    "CES policy",
  );
  for (const name of STATE_ROOTS)
    expect(await readdir(join(root, name))).not.toContain("after-upgrade");
  expect(tokens).not.toHaveBeenCalled();
});

test("missing registry identity fails before capture instead of trying runtime export", async () => {
  lookup.mockReturnValue(null);
  expect(await backups.createBackup("missing")).toBeNull();
  expect(await backups.restoreBackup("missing", "missing.tar.gz")).toBe(false);
  expect(tokens).not.toHaveBeenCalled();
});
