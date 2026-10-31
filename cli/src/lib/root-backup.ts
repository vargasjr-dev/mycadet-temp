import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { z } from "zod";
import {
  isLocalEntry,
  saveLockfileAssistant,
  type DockerAssistant,
  type LocalAssistant,
} from "@mycadet/local-mode";
import type { LockfileAssistant } from "./assistant-config.js";
import { getDaemonPidPath, getLocalInstanceDir } from "./assistant-config.js";
import { getBackupsDir } from "./backup-ops.js";
import { dockerResourceNames } from "./docker.js";
import { execOutput } from "./step-runner.js";
import { isProcessAlive } from "./process.js";
import { probePort } from "./port-probe.js";
import {
  waitForDaemonReady,
  waitForDaemonMigrationsReady,
} from "./http-client.js";
import { loadGuardianBootstrapSecret } from "./guardian-token.js";
import {
  requireReadyRuntimeEntry,
  startCes,
  startGateway,
  startLocalDaemon,
} from "./remotes/local.js";
import {
  ASSISTANT_INTERNAL_PORT,
  GATEWAY_INTERNAL_PORT,
} from "./environments/paths.js";
import { sleepAssistant } from "../commands/sleep.js";
import { wakeAssistant } from "../commands/wake.js";

export const STATE_ROOTS = [
  "workspace",
  "gateway-security",
  "ces-security",
  "ces-data",
] as const;
type StateRoot = (typeof STATE_ROOTS)[number];
const ROOT_SET = new Set<string>(STATE_ROOTS);
const TRANSIENT_PATHS = new Set([
  "workspace/cadet.pid",
  "workspace/signals",
  "workspace/data/ingress/nginx.pid",
]);

function persistent(
  path: string,
  stat: import("node:fs").Stats | tar.ReadEntry,
): boolean {
  return (
    !TRANSIENT_PATHS.has(path) &&
    ("isFile" in stat
      ? stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()
      : ["File", "Directory", "SymbolicLink", "Link"].includes(stat.type))
  );
}

/** Plain tar root layout; no credential decoding or logical workspace transformation. */
export async function packRoot(root: string, output: string): Promise<void> {
  await mkdir(dirname(resolve(output)), { recursive: true });
  const partial = `${resolve(output)}.${randomUUID()}.partial`;
  // Pre-create privately: tar must never briefly create a world-readable backup.
  await writeFile(partial, "", { mode: 0o600, flag: "wx" });
  try {
    await tar.c(
      {
        cwd: root,
        file: partial,
        gzip: true,
        strict: true,
        portable: true,
        filter: (path, stat) => {
          if (!persistent(path, stat)) return false;
          if (
            "isFile" in stat
              ? stat.isSymbolicLink()
              : stat.type === "SymbolicLink"
          ) {
            // A link the validator would reject is skipped instead of failing
            // the whole pack: one bad store symlink in node_modules must not
            // cost the user their pre-upgrade backup.
            let target = "";
            try {
              target = readlinkSync(resolve(root, path));
            } catch {
              target = "";
            }
            if (unsafeLinkTarget(path, target)) {
              console.warn(
                `Backup skipped unsafe link: ${path} -> ${target || "(unreadable)"}`,
              );
              return false;
            }
          }
          return true;
        },
      },
      [...STATE_ROOTS],
    );
    // Validate our own artifact before publishing it, including safe link topology.
    await validateRootArchive(partial);
    await rename(partial, resolve(output));
  } finally {
    await rm(partial, { force: true });
  }
}

function archivePath(path: string): string {
  const stripped = path.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (
    !stripped ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    stripped.split("/").some((p) => p === ".." || p === "." || !p) ||
    !ROOT_SET.has(stripped.split("/")[0]!)
  ) {
    throw new Error(`Invalid root archive path: ${path}`);
  }
  return stripped;
}

/**
 * Mirrors validateRootArchive's symlink rules: true when a link with this
 * target would be rejected at restore. packRoot skips exactly these at pack
 * time so one regenerable store symlink can't fail the whole backup.
 */
function unsafeLinkTarget(entryPath: string, rawTarget: string): boolean {
  if (
    !rawTarget ||
    rawTarget.startsWith("/") ||
    rawTarget.includes("\\") ||
    /^[a-z]:/i.test(rawTarget)
  ) {
    return true;
  }
  try {
    archivePath(
      posix.normalize(posix.join(posix.dirname(entryPath), rawTarget)),
    );
  } catch {
    return true;
  }
  return false;
}

export async function validateRootArchive(file: string): Promise<void> {
  if (/\.vbundle(?:\.enc)?$/i.test(file)) {
    throw new Error(
      "Legacy .vbundle conversion belongs in vellum-to-cadet. Supply a root tar archive.",
    );
  }
  const entries = new Map<string, string>();
  let invalid: Error | undefined;
  await tar.t({
    file,
    strict: true,
    onReadEntry: (entry) => {
      // Defer rejection until the stream drains; never throw out of a stream callback.
      try {
        if (entry.path === "./" && entry.type === "Directory") return;
        const path = archivePath(entry.path);
        if (entries.has(path))
          throw new Error(`Duplicate archive entry: ${path}`);
        if (
          !["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)
        ) {
          throw new Error(`Unsupported archive entry: ${path}`);
        }
        entries.set(path, entry.type);
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          const target = entry.linkpath ?? "";
          if (
            !target ||
            target.startsWith("/") ||
            target.includes("\\") ||
            /^[a-z]:/i.test(target)
          ) {
            throw new Error(`Unsafe archive link: ${path}`);
          }
          archivePath(
            entry.type === "Link"
              ? target
              : posix.normalize(posix.join(posix.dirname(path), target)),
          );
        }
      } catch (error) {
        invalid ??= error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (invalid) throw invalid;
  for (const root of STATE_ROOTS) {
    if (entries.get(root) !== "Directory")
      throw new Error(`Archive is missing state root: ${root}`);
  }
  for (const path of entries.keys()) {
    let parent = posix.dirname(path);
    while (parent !== ".") {
      if (
        entries.get(parent) === "SymbolicLink" ||
        entries.get(parent) === "Link"
      )
        throw new Error(`Archive writes through a link: ${path}`);
      parent = posix.dirname(parent);
    }
  }
}

export async function stageRootArchive(
  file: string,
  parent = tmpdir(),
): Promise<string> {
  if (/\.vbundle(?:\.enc)?$/i.test(file))
    throw new Error(
      "Convert legacy .vbundle backups with vellum-to-cadet before restoring.",
    );
  const stage = await mkdtemp(join(parent, ".cadet-restore-"));
  await chmod(stage, 0o700);
  try {
    // Copy once so validation and extraction operate on identical bytes.
    const input = join(stage, "input.tar");
    await cp(resolve(file), input);
    await chmod(input, 0o600);
    await validateRootArchive(input);
    const root = join(stage, "state");
    await mkdir(root, { mode: 0o700 });
    await tar.x({
      file: input,
      cwd: root,
      strict: true,
      preserveOwner: false,
      noChmod: false,
    });
    await rm(input);
    await pruneTransient(root);
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export interface RootStorage {
  running(): Promise<boolean>;
  capture(target: string): Promise<void>;
  replace(source: string): Promise<void>;
  prepareRestore?(source: string): Promise<void>;
}

export class LocalRootStorage implements RootStorage {
  readonly root: string;
  initialRunning?: Set<string>;
  private readonly localEntry: LocalAssistant | DockerAssistant;
  constructor(readonly entry: LockfileAssistant) {
    // Local-style roots: plain on-machine instances and docker instances
    // (whose state roots are volumes) both carry the recorded paths.
    if (entry.cloud !== "local" && entry.cloud !== "docker")
      throw new Error("Local backup requires an on-machine instance.");
    this.localEntry = entry;
    this.root = resolve(getLocalInstanceDir(entry));
  }
  async running(): Promise<boolean> {
    const running = new Set(
      [
        ["assistant", getDaemonPidPath(this.localEntry)],
        ["gateway", join(this.root, "gateway.pid")],
        ["ces", join(this.root, "ces.pid")],
      ]
        .filter(([, file]) => isProcessAlive(file!).alive)
        .map(([service]) => service!),
    );
    const entry = this.localEntry;
    for (const [service, port] of [
      ["assistant", entry.daemonPort],
      ["gateway", entry.port],
      ["ces", entry.cesPort],
    ] as const) {
      if (
        !running.has(service) &&
        port !== undefined &&
        (await probePort(port))
      ) {
        throw new Error(
          `${service} port ${port} is occupied without a live PID file; stop that service before backup/restore.`,
        );
      }
    }
    this.initialRunning ??= running;
    return running.size > 0;
  }
  async resume(): Promise<void> {
    if (this.initialRunning?.size === 3) {
      await wakeAssistant(this.entry, {
        watch: false,
        foreground: false,
      });
      await this.checkReady();
      return;
    }
    const entry = this.localEntry;
    if (
      this.initialRunning?.has("ces") &&
      !isProcessAlive(join(this.root, "ces.pid")).alive
    )
      await startCes(false, entry);
    if (
      this.initialRunning?.has("assistant") &&
      !isProcessAlive(getDaemonPidPath(entry)).alive
    )
      await startLocalDaemon(false, requireReadyRuntimeEntry(entry));
    if (
      this.initialRunning?.has("gateway") &&
      !isProcessAlive(join(this.root, "gateway.pid")).alive
    )
      await startGateway(false, entry, {
        bootstrapSecret: loadGuardianBootstrapSecret(
          this.localEntry.assistantId,
        ),
      });
    await this.checkReady();
  }
  private async checkReady(): Promise<void> {
    const entry = this.localEntry;
    if (
      this.initialRunning?.has("assistant") &&
      entry.daemonPort !== undefined &&
      (await waitForDaemonMigrationsReady(
        entry.daemonPort,
        Date.now() + 60_000,
      )) !== "ready"
    ) {
      throw new Error(
        "Assistant did not become ready after restoring its running state.",
      );
    }
    for (const [service, port] of [
      ["gateway", entry.port],
      ["ces", entry.cesPort],
    ] as const) {
      if (
        this.initialRunning?.has(service) &&
        port !== undefined &&
        !(await waitForDaemonReady(port))
      )
        throw new Error(`${service} did not become healthy after restart.`);
    }
  }
  async capture(target: string): Promise<void> {
    for (const root of STATE_ROOTS) {
      const source = join(this.root, root);
      const stat = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (!stat) throw new Error(`Persistent state root is missing: ${root}`);
      if (!stat.isDirectory())
        throw new Error(`State root must be a directory: ${root}`);
      await cp(source, join(target, root), {
        recursive: true,
        verbatimSymlinks: true,
        filter: async (path) =>
          persistent(
            posix.join(
              root,
              path
                .slice(source.length + 1)
                .split("\\")
                .join("/"),
            ),
            await lstat(path),
          ),
      });
    }
  }
  async replace(source: string): Promise<void> {
    // All renames stay on the instance's filesystem. A failed install rolls back
    // every root, including the root whose incoming rename failed.
    const work = await mkdtemp(join(dirname(this.root), ".cadet-install-"));
    await chmod(work, 0o700);
    const installed: StateRoot[] = [];
    const saved: StateRoot[] = [];
    let recovered = false;
    try {
      for (const root of STATE_ROOTS) {
        await cp(join(source, root), join(work, `new-${root}`), {
          recursive: true,
          verbatimSymlinks: true,
        });
        await chmod(join(work, `new-${root}`), 0o700);
      }
      for (const root of STATE_ROOTS) {
        if (
          await lstat(join(this.root, root)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            },
          )
        ) {
          await rename(join(this.root, root), join(work, `old-${root}`));
          saved.push(root);
        }
        await rename(join(work, `new-${root}`), join(this.root, root));
        installed.push(root);
      }
      recovered = true;
    } catch (error) {
      try {
        for (const root of installed.reverse())
          await rm(join(this.root, root), { recursive: true, force: true });
        for (const root of saved.reverse())
          await rename(join(work, `old-${root}`), join(this.root, root));
        recovered = true;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Restore and rollback failed. Original roots are retained at ${work}; services must stay stopped.`,
        );
      }
      throw error;
    } finally {
      if (recovered) await rm(work, { recursive: true, force: true });
    }
  }
}

const ContainerInspectionSchema = z.object({
  Image: z.string(),
  State: z.object({ Status: z.string(), Running: z.boolean() }),
  Config: z.object({ Env: z.array(z.string()), User: z.string() }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Source: z.string(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
});
type ContainerInspection = z.infer<typeof ContainerInspectionSchema>;

export interface DockerBackupOps {
  output: typeof execOutput;
  copy: (container: string, path: string, target: string) => Promise<void>;
  install: (args: string[], source: string) => Promise<void>;
}

const dockerOps: DockerBackupOps = {
  output: execOutput,
  copy: async (container, path, target) => {
    await execOutput("docker", ["cp", `${container}:${path}/.`, target]);
  },
  install: async (args, source) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<void>((done, fail) => {
      child.once("error", fail);
      child.once("close", (code) =>
        code === 0
          ? done()
          : fail(new Error(`Docker restore failed (${code}): ${stderr}`)),
      );
    });
    const input = tar.c({ cwd: source, portable: true }, ["."]);
    const transfer = pipeline(input, child.stdin).catch((error) => {
      child.kill("SIGTERM");
      throw error;
    });
    // Do not begin recovery while an earlier writer still owns the volume.
    const results = await Promise.allSettled([transfer, exited]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  },
};

export class DockerRootStorage implements RootStorage {
  readonly containers: Record<StateRoot, string>;
  initialRunning?: Set<string>;
  constructor(
    readonly entry: LockfileAssistant,
    readonly ops: DockerBackupOps = dockerOps,
  ) {
    const names = dockerResourceNames(entry.assistantId);
    this.containers = {
      workspace: names.assistantContainer,
      "gateway-security": names.gatewayContainer,
      "ces-security": names.cesContainer,
      "ces-data": names.cesContainer,
    };
  }
  async inspect(container: string): Promise<ContainerInspection> {
    const result = z
      .array(ContainerInspectionSchema)
      .length(1)
      .safeParse(
        JSON.parse(await this.ops.output("docker", ["inspect", container])),
      );
    if (!result.success) {
      throw new Error(`Invalid container inspection: ${container}`);
    }
    return result.data[0]!;
  }
  async running(): Promise<boolean> {
    const containers = [...new Set(Object.values(this.containers))];
    const states = await Promise.all(
      containers.map((container) => this.inspect(container)),
    );
    for (const state of states) {
      if (!["created", "running", "exited"].includes(state.State.Status)) {
        throw new Error(
          `Container is ${state.State.Status}; stop or repair it before backup/restore.`,
        );
      }
    }
    this.initialRunning ??= new Set(
      containers.filter((_, index) => states[index]!.State.Running),
    );
    return states.some((state) => state.State.Running);
  }
  async resume(): Promise<void> {
    if (this.initialRunning?.size === 3) {
      await wakeAssistant(this.entry, {
        watch: false,
        foreground: false,
      });
    } else {
      for (const container of new Set(Object.values(this.containers))) {
        if (
          this.initialRunning?.has(container) &&
          !(await this.inspect(container)).State.Running
        ) {
          await this.ops.output("docker", ["start", container]);
        }
      }
    }
    // Probe inside the destination containers, so remote Docker contexts work
    // without assuming their published ports are reachable on this CLI host.
    const endpoints = [
      [this.containers.workspace, ASSISTANT_INTERNAL_PORT, "readyz"],
      [this.containers["gateway-security"], GATEWAY_INTERNAL_PORT, "healthz"],
      [this.containers["ces-security"], 8090, "healthz"],
    ] as const;
    await Promise.all(
      endpoints.map(async ([container, defaultPort, endpoint]) => {
        if (!this.initialRunning?.has(container)) return;
        const state = await this.inspect(container);
        const portVariable =
          container === this.containers.workspace
            ? "RUNTIME_HTTP_PORT="
            : "GATEWAY_PORT=";
        const configuredPort =
          container === this.containers["ces-security"]
            ? undefined
            : state.Config.Env.find((value) =>
                value.startsWith(portVariable),
              )?.split("=")[1];
        const port = configuredPort ? Number(configuredPort) : defaultPort;
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
          throw new Error(`Invalid health port for ${container}.`);
        const deadline = Date.now() + 60_000;
        const script =
          'const url=process.argv.at(-1); const r=await fetch(url,{signal:AbortSignal.timeout(1500)}); if(!r.ok)process.exit(1); if(url.endsWith("/readyz")){const b=await r.json(); if(b.dbMigrations?.state==="failed"){console.error("migration_failed");process.exit(2)} if(b.ready===false)process.exit(1)} console.log("ready")';
        while (true) {
          try {
            await this.ops.output(
              "docker",
              [
                "exec",
                container,
                "bun",
                "--eval",
                script,
                `http://127.0.0.1:${port}/${endpoint}`,
              ],
              { timeoutMs: 3000 },
            );
            return;
          } catch (error) {
            if (
              String(error).includes("migration_failed") ||
              Date.now() >= deadline
            )
              throw new Error(
                `${container} did not become ready after restart.`,
                { cause: error },
              );
            await new Promise((done) => setTimeout(done, 250));
          }
        }
      }),
    );
  }
  async capture(target: string): Promise<void> {
    for (const root of STATE_ROOTS) {
      await mkdir(join(target, root), { mode: 0o700 });
      await this.ops.copy(
        this.containers[root],
        `/${root}`,
        join(target, root),
      );
    }
    // docker cp may retain sockets in its tar stream; remove only process artifacts.
    await pruneTransient(target);
  }
  private async restoreMounts(_source: string) {
    const inspections = new Map<string, ContainerInspection>();
    for (const container of new Set(Object.values(this.containers)))
      inspections.set(container, await this.inspect(container));
    return STATE_ROOTS.map((root) => {
      const state = inspections.get(this.containers[root])!;
      const mount = state.Mounts.find(
        (item) => item.Destination === `/${root}`,
      );
      if (!mount?.RW || !["volume", "bind"].includes(mount.Type))
        throw new Error(`No writable persistent mount for ${root}.`);
      const source = mount.Type === "volume" ? mount.Name : mount.Source;
      if (!source || source.includes(","))
        throw new Error(`Unsupported mount source for ${root}.`);
      // Ownership is destination-owned, never the uid from the archive/host.
      const user = state.Config.User || "1001:1001";
      const owner =
        root === "workspace"
          ? "1001:1001"
          : user.includes(":")
            ? user
            : `${user}:${user}`;
      if (!/^[\w.-]+(?::[\w.-]+)?$/.test(owner))
        throw new Error(`Invalid destination user for ${root}.`);
      return {
        root,
        state,
        owner,
        mount: `type=${mount.Type},src=${source},dst=/restore`,
      };
    });
  }
  async prepareRestore(source: string): Promise<void> {
    await this.restoreMounts(source);
  }
  async replace(source: string): Promise<void> {
    const mounts = await this.restoreMounts(source);
    for (const { root, state, mount, owner } of mounts) {
      await this.ops.install(
        [
          "run",
          "--rm",
          "-i",
          "--network=none",
          "--user=0",
          "--mount",
          mount,
          "--entrypoint=/bin/sh",
          state.Image,
          "-ec",
          'find /restore -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xpf - -C /restore; chown -R "$1" /restore; chmod 700 /restore',
          "cadet-restore",
          owner,
        ],
        join(source, root),
      );
    }
  }
}

async function pruneTransient(root: string, relative = ""): Promise<void> {
  for (const name of await readdir(join(root, relative))) {
    const path = posix.join(relative, name);
    const stat = await lstat(join(root, path));
    if (!persistent(path, stat))
      await rm(join(root, path), { recursive: true, force: true });
    else if (stat.isDirectory()) await pruneTransient(root, path);
  }
}

export interface RootBackupOps {
  storage: RootStorage;
  sleep: () => Promise<void>;
  wake: () => Promise<void>;
  save: (entry: LockfileAssistant) => void;
}

function defaultOps(entry: LockfileAssistant): RootBackupOps {
  const storage =
    entry.cloud === "docker"
      ? new DockerRootStorage(entry)
      : new LocalRootStorage(entry);
  return {
    storage,
    sleep: () =>
      sleepAssistant(entry, {
        force: false,
        wait: false,
        waitMs: null,
      }),
    wake: () => storage.resume(),
    save: saveLockfileAssistant,
  };
}

async function assertStopped(storage: RootStorage): Promise<void> {
  if (await storage.running())
    throw new Error(
      "Services are still running; no consistent root capture is possible.",
    );
}

const ownedOperationLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** Hold storage ownership across lifecycle steps; nested backup calls share the lock. */
export async function withRootOperationLock<T>(
  entry: LockfileAssistant,
  work: () => Promise<T>,
): Promise<T> {
  const parent = join(getBackupsDir(), ".operations");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const identity =
    entry.cloud === "docker"
      ? `${process.env.DOCKER_HOST ?? ""}:${process.env.DOCKER_CONTEXT ?? ""}:${entry.assistantId}`
      : isLocalEntry(entry)
        ? entry.instanceDir
        : undefined;
  const lock = join(
    parent,
    createHash("sha256")
      .update(identity ?? entry.assistantId)
      .digest("hex"),
  );
  const owned = ownedOperationLocks.getStore();
  if (owned?.has(lock)) {
    return work();
  }
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Another backup/restore owns ${lock}. If its process has exited, remove that operation lock and retry.`,
      );
    throw error;
  }
  try {
    return await ownedOperationLocks.run(
      new Set([...(owned ?? []), lock]),
      work,
    );
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function createRootBackup(
  entry: LockfileAssistant,
  output: string,
  ops = defaultOps(entry),
): Promise<void> {
  return withRootOperationLock(entry, () => captureBackup(entry, output, ops));
}

async function captureBackup(
  entry: LockfileAssistant,
  output: string,
  ops: RootBackupOps,
): Promise<void> {
  if (
    entry.cloud !== "docker" &&
    entry.cloud !== "cloud" &&
    entry.cloud !== "custom" &&
    entry.cloud !== "baseten"
  ) {
    for (const root of STATE_ROOTS) {
      const path = resolve(getLocalInstanceDir(entry), root);
      if (resolve(output) === path || resolve(output).startsWith(`${path}/`))
        throw new Error("Save backups outside the persistent service roots.");
    }
  }
  const stage = await mkdtemp(join(tmpdir(), "cadet-backup-"));
  await chmod(stage, 0o700);
  let running = false;
  let stopped = false;
  try {
    running = await ops.storage.running();
    stopped = running;
    if (running) await ops.sleep();
    stopped = true;
    await assertStopped(ops.storage);
    await ops.storage.capture(stage);
    await assertStopped(ops.storage);
    if (running) {
      await ops.wake();
      stopped = false;
    }
    await packRoot(stage, output);
  } finally {
    try {
      if (running && stopped) await ops.wake();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}

export async function restoreRootBackup(
  entry: LockfileAssistant,
  file: string,
  options: { dryRun?: boolean; recoveryPath?: string; resume?: boolean } = {},
  ops = defaultOps(entry),
): Promise<string | undefined> {
  return withRootOperationLock(entry, () =>
    restoreBackup(entry, file, options, ops),
  );
}

/** Install into a newly allocated instance before any service starts. */
export async function initializeRootArchive(
  entry: LockfileAssistant,
  file: string,
  storage: RootStorage = entry.cloud === "docker"
    ? new DockerRootStorage(entry)
    : new LocalRootStorage(entry),
): Promise<void> {
  return withRootOperationLock(entry, async () => {
    const stage = await stageRootArchive(file);
    try {
      const source = join(stage, "state");
      await storage.prepareRestore?.(source);
      await assertStopped(storage);
      await storage.replace(source);
      return undefined;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}

async function restoreBackup(
  entry: LockfileAssistant,
  file: string,
  options: { dryRun?: boolean; recoveryPath?: string; resume?: boolean },
  ops: RootBackupOps,
): Promise<string | undefined> {
  const stage = await stageRootArchive(file);
  const source = join(stage, "state");
  const snapshot = join(stage, "previous");
  let stopped = false;
  let replacing = false;
  let restored = false;
  let running = false;
  let recoveryPath: string | undefined;
  try {
    await ops.storage.prepareRestore?.(source);
    if (options.dryRun) return undefined;
    running = await ops.storage.running();
    stopped = running;
    if (running) await ops.sleep();
    stopped = true;
    await assertStopped(ops.storage);
    await mkdir(snapshot, { mode: 0o700 });
    await ops.storage.capture(snapshot);
    recoveryPath =
      options.recoveryPath ??
      join(
        getBackupsDir(),
        `${entry.assistantId}-pre-restore-${Date.now()}.tar.gz`,
      );
    await packRoot(snapshot, recoveryPath);
    await assertStopped(ops.storage);
    replacing = true;
    try {
      await ops.storage.replace(source);
      restored = true;
    } catch (error) {
      try {
        await ops.storage.replace(snapshot);
        replacing = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Restore failed and could not recover. Services remain stopped; recovery archive: ${recoveryPath}`,
        );
      }
      throw error;
    }
    if (running && options.resume !== false) {
      try {
        await ops.wake();
        stopped = false;
      } catch (error) {
        try {
          await ops.sleep();
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            `Restored state could not start or stop cleanly. Recovery archive: ${recoveryPath}`,
          );
        }
        throw new Error(
          `Restored state could not start; services were stopped. Recovery archive: ${recoveryPath}`,
          { cause: error },
        );
      }
    }
    return recoveryPath;
  } finally {
    try {
      // A failed replacement/failed start must never boot partially restored state.
      if (
        running &&
        stopped &&
        !replacing &&
        !restored &&
        options.resume !== false
      )
        await ops.wake();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
