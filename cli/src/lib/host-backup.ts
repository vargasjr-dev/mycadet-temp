import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { streamExportVBundle } from "@mycadet/backup";
import { createLocalSecureKeyBackend } from "@mycadet/credential-storage";

import type { AssistantEntry } from "./assistant-config.js";
import { dockerResourceNames } from "./docker.js";
import { isCadetProcess } from "./process.js";
import { exec, execOutput } from "./step-runner.js";
import { getStateDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";

export interface HostBackupOps {
  exec: typeof exec;
  execOutput: typeof execOutput;
  processOwned: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
}

const defaults: HostBackupOps = {
  exec,
  execOutput,
  processOwned: isCadetProcess,
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/** Host-owned backups capture committed SQLite data and retain the portable bundle format. */
export async function writeHostVBundle(
  entry: AssistantEntry,
  outputPath: string,
  ops: HostBackupOps = defaults,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "cadet-backup-"));
  const workspace = join(scratch, "workspace");
  const security = join(scratch, "ces-security");
  let runtimeVersion =
    entry.resources?.runtimeVersion ??
    (typeof entry.version === "string" ? entry.version : "");
  let liveDatabase: string | undefined;
  const resume: Array<() => Promise<void>> = [];
  try {
    if (entry.cloud === "docker") {
      const names = dockerResourceNames(entry.assistantId);
      for (const container of [
        names.assistantContainer,
        names.gatewayContainer,
        names.cesContainer,
      ]) {
        const state = (
          await ops.execOutput("docker", [
            "inspect",
            "--format",
            "{{.State.Status}}",
            container,
          ])
        ).trim();
        if (state === "running") {
          await ops.exec("docker", ["pause", container]);
          resume.push(() => ops.exec("docker", ["unpause", container]));
        }
      }
      const image = (
        await ops.execOutput("docker", [
          "inspect",
          "--format",
          "{{.Config.Image}}",
          names.assistantContainer,
        ])
      ).trim();
      runtimeVersion =
        image.match(/:v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:@|$)/)?.[1] ??
        runtimeVersion;
      await mkdir(workspace);
      await mkdir(security);
      await ops.exec("docker", [
        "cp",
        `${names.assistantContainer}:/workspace/.`,
        workspace,
      ]);
      await ops.exec("docker", [
        "cp",
        `${names.cesContainer}:/ces-security/.`,
        security,
      ]);
    } else {
      const root =
        entry.resources?.instanceDir ?? getStateDir(getCurrentEnvironment());
      const source = join(root, "workspace");
      liveDatabase = join(source, "data", "db", "assistant.db");
      if (!existsSync(source))
        throw new Error(
          "The assistant workspace is not available on this host.",
        );
      for (const pidPath of [
        join(source, "cadet.pid"),
        join(root, "gateway.pid"),
        join(root, "ces.pid"),
      ]) {
        if (!existsSync(pidPath)) continue;
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (
          (ops.platform ?? process.platform) !== "win32" &&
          Number.isInteger(pid) &&
          pid > 0 &&
          pid !== process.pid &&
          ops.processOwned(pid)
        ) {
          ops.signal(pid, "SIGSTOP");
          resume.push(async () => {
            ops.signal(pid, "SIGCONT");
          });
        }
      }
      await cp(source, workspace, {
        recursive: true,
        verbatimSymlinks: true,
        filter: async (path) => {
          const relative = path
            .slice(source.length + 1)
            .split("\\")
            .join("/");
          if (
            ["signals", "data/qdrant", "embedding-models", "deprecated"].some(
              (excluded) =>
                relative === excluded || relative.startsWith(excluded + "/"),
            )
          )
            return false;
          const kind = await lstat(path);
          return kind.isFile() || kind.isDirectory() || kind.isSymbolicLink();
        },
      });
      if (existsSync(join(root, "ces-security")))
        await cp(join(root, "ces-security"), security, { recursive: true });
    }
    // The service processes only remain suspended while their files are copied.
    while (resume.length) {
      await resume[resume.length - 1]!();
      resume.pop();
    }
    if (!runtimeVersion)
      throw new Error(
        "The running assistant version is unavailable in its host state.",
      );
    const dbPath = join(workspace, "data", "db", "assistant.db");
    if (
      (ops.platform ?? process.platform) === "win32" &&
      liveDatabase &&
      existsSync(liveDatabase)
    ) {
      const snapshot = `${dbPath}.snapshot`;
      const db = new Database(liveDatabase, { readonly: true });
      try {
        db.query("VACUUM INTO ?").run(snapshot);
      } finally {
        db.close();
      }
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
        await rm(path, { force: true });
      await rename(snapshot, dbPath);
    }
    if (existsSync(dbPath)) {
      const db = new Database(dbPath);
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    }
    const backend = createLocalSecureKeyBackend(security);
    const credentials: Array<{ account: string; value: string }> = [];
    for (const account of await backend.list()) {
      const value = await backend.get(account);
      if (value === undefined)
        throw new Error("A stored credential could not be exported.");
      credentials.push({ account, value });
    }
    const bundle = await streamExportVBundle({
      assistant: {
        id: entry.assistantId,
        name: entry.name ?? entry.assistantId,
        runtime_version: runtimeVersion,
      },
      origin: {
        mode:
          entry.cloud === "docker" ? "self-hosted-remote" : "self-hosted-local",
      },
      compatibility: {
        min_runtime_version: runtimeVersion,
        max_runtime_version: null,
      },
      exportOptions: {
        include_logs: true,
        include_browser_state: true,
        include_memory_vectors: false,
      },
      secretsRedacted: false,
      workspaceDir: workspace,
      credentials,
    });
    const pending = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(outputPath), { recursive: true });
      await cp(bundle.tempPath, pending);
      chmodSync(pending, 0o600);
      await rename(pending, outputPath);
    } finally {
      await rm(pending, { force: true });
      await bundle.cleanup();
    }
  } finally {
    const results = await Promise.allSettled(
      resume.map((restore) => restore()),
    );
    await rm(scratch, { recursive: true, force: true });
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Backup cleanup could not resume all assistant services. Run cadet wake to recover them.",
      );
  }
}
