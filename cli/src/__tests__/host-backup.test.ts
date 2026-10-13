import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSecureKeyBackend } from "@mycadet/credential-storage";
import { validateVBundle } from "@mycadet/backup/validator";
import { writeHostVBundle, type HostBackupOps } from "../lib/host-backup.js";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-backup-test-"));
  scratch.push(root);
  await mkdir(join(root, "workspace/data/db"), { recursive: true });
  await mkdir(join(root, "ces-security"));
  const db = new Database(join(root, "workspace/data/db/assistant.db"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages (content TEXT); INSERT INTO messages VALUES ('committed in WAL')",
  );
  await writeFile(
    join(root, "workspace/config.json"),
    JSON.stringify({ ingress: { publicBaseUrl: "https://host.example" } }),
  );
  const backend = createLocalSecureKeyBackend(join(root, "ces-security"));
  await backend.set("credential/test/api_key", "fixture-secret");
  return { root, db };
}

test.each(["linux", "win32"])(
  "host export retains WAL rows, credentials, and portable config without HTTP/token dependencies (%s)",
  async (platform) => {
    const { root, db } = await fixture();
    try {
      const output = join(root, "backup.vbundle");
      await writeHostVBundle(
        {
          assistantId: "assistant-123",
          name: "Example",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:1",
          resources: {
            instanceDir: root,
            gatewayPort: 7830,
            daemonPort: 7821,
            qdrantPort: 6333,
            cesPort: 8090,
            runtimeVersion: "0.12.9",
          },
        },
        output,
        {
          platform: platform === "win32" ? "win32" : "linux",
          exec: async () => {
            throw new Error("Unexpected container command");
          },
          execOutput: async () => {
            throw new Error("Unexpected container command");
          },
          processOwned: () => false,
          signal: () => {
            throw new Error("Unexpected process signal");
          },
        },
      );
      const valid = validateVBundle(new Uint8Array(await readFile(output)));
      expect(valid.is_valid).toBe(true);
      expect(valid.manifest?.assistant.runtime_version).toBe("0.12.9");
      const database = valid.entries?.get("workspace/data/db/assistant.db");
      expect(database).toBeDefined();
      const restored = join(root, "restored.db");
      await writeFile(restored, database!.data);
      const check = new Database(restored, { readonly: true });
      try {
        expect(check.query("SELECT content FROM messages").get()).toEqual({
          content: "committed in WAL",
        });
      } finally {
        check.close();
      }
      expect(
        new TextDecoder().decode(
          valid.entries?.get("credentials/credential/test/api_key")?.data,
        ),
      ).toBe("fixture-secret");
      expect(
        new TextDecoder().decode(
          valid.entries?.get("workspace/config.json")?.data,
        ),
      ).not.toContain("https://host.example");
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  },
);

test("Docker copy failure resumes every container paused by the backup", async () => {
  const calls: string[][] = [];
  const ops: HostBackupOps = {
    execOutput: async (_command, args) =>
      args.includes("{{.Config.Image}}")
        ? "example/assistant:v0.12.9"
        : "running",
    exec: async (_command, args) => {
      calls.push(args);
      if (args[0] === "cp") throw new Error("copy failed");
    },
    processOwned: () => false,
    signal: () => {},
  };
  await expect(
    writeHostVBundle(
      {
        assistantId: "assistant-123",
        cloud: "docker",
        runtimeUrl: "http://127.0.0.1:1",
      },
      "/tmp/unused.vbundle",
      ops,
    ),
  ).rejects.toThrow("copy failed");
  expect(calls.filter((args) => args[0] === "pause")).toHaveLength(3);
  expect(calls.filter((args) => args[0] === "unpause")).toHaveLength(3);
});

test("an unreadable credential store fails the export rather than omitting secrets", async () => {
  const { root, db } = await fixture();
  try {
    await rm(join(root, "ces-security/store.key"));
    await expect(
      writeHostVBundle(
        {
          assistantId: "assistant-123",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:1",
          version: "0.12.9",
          resources: {
            instanceDir: root,
            gatewayPort: 7830,
            daemonPort: 7821,
            qdrantPort: 6333,
            cesPort: 8090,
          },
        },
        join(root, "backup.vbundle"),
      ),
    ).rejects.toThrow();
  } finally {
    db.close();
  }
});
