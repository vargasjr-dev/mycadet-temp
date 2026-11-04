/**
 * The hatch operation's docker provision core: ensure the docker toolchain,
 * resolve and acquire the three service images, create the network and
 * volumes, stage the fresh daemon's first-boot config overlay, start (or
 * create-only, for a teleport's initialize-data half) the containers,
 * persist the entry, then wait for readiness and lease the guardian token.
 *
 * The interactive provider prompt, the hatch log file, the next-steps
 * banner, and the watch-mode file watcher are the CLI's ceremony around
 * this door — they need a TTY and a long-lived process. Everything here is
 * mechanics a serving host can run.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDevVersion } from "@mycadet/shared/version";
import {
  buildHatchConfigValues,
  writeInitialConfig,
} from "../local/hatch-config";
import { generateInstanceName } from "../../naming";
import {
  ASSISTANT_INTERNAL_PORT,
  findOpenPort,
  getDefaultPorts,
} from "../../ports";
import { leaseGuardianToken } from "../../guardian-token";
import { classifyReadyzResponse } from "../../daemon-readiness";
import { loopbackSafeFetch } from "../../loopback-fetch";
import { configureHatchProviderApiKey } from "../../provider-credentials";
import { saveLockfileAssistant } from "../../lockfile";
import { exec, execOutput, execWithStdin } from "../../exec";
import { buildImage, serviceImageConfigs, startFileWatcher } from "./watch";
import type {
  DockerAssistant,
  LockfileAssistant,
} from "../../lockfile-contract";
import { getGatewayUrl } from "../../lockfile-contract";
import { getOrCreateHostDeviceId } from "../../device-id";
import {
  ensureLocalBinOnPath,
  LOCAL_BIN_DIR,
  startColimaAndAwaitDaemon,
} from "./common";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "../../lifecycle-reporter";
import { dockerResourceNames } from "./retire";
import {
  type DockerResourceNames,
  type ServiceName,
  startContainers,
  stopContainers,
} from "./statefulset";
import {
  HOST_IMAGE_LOADER_URL,
  isLocalBuildRef,
  loadImageViaHost,
} from "./host-image-loader";

const DOCKERHUB_ORG = "mycadet";

export function dockerhubImages(
  cliVersion: string,
): Record<ServiceName, string> {
  const suffix = isDevVersion(cliVersion) ? "-dev" : "";
  return {
    assistant: `${DOCKERHUB_ORG}/mycadet-assistant${suffix}`,
    "credential-executor": `${DOCKERHUB_ORG}/mycadet-credential-executor${suffix}`,
    gateway: `${DOCKERHUB_ORG}/mycadet-gateway${suffix}`,
  };
}

/**
 * The Docker Hub image refs for a release version — the upgrade path's
 * resolver (target version stamped, repo names from the running CLI's
 * release channel).
 */
export function resolveImageRefs(
  targetVersion: string,
  cliVersion: string,
): Record<ServiceName, string> {
  const versionTag = targetVersion.startsWith("v")
    ? targetVersion.slice(1)
    : targetVersion;
  const images = dockerhubImages(cliVersion);
  return {
    assistant: `${images.assistant}:${versionTag}`,
    "credential-executor": `${images["credential-executor"]}:${versionTag}`,
    gateway: `${images.gateway}:${versionTag}`,
  };
}

/** Convenience wrapper for "the images this CLI itself was built from". */
export function resolveOwnImageRefs(
  cliVersion: string,
): Record<ServiceName, string> {
  return resolveImageRefs(cliVersion || "latest", cliVersion);
}

/** Max time to wait for the assistant container to emit the readiness sentinel. */
export const DOCKER_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** Default memory (GiB) allocated to the Colima VM. */
const COLIMA_DEFAULT_MEMORY_GIB = 8;

/**
 * Returns the macOS architecture suffix used by GitHub release artifacts.
 * Maps Node's `arch()` values to the names used in release URLs.
 */
function releaseArch(): string {
  const a = arch();
  if (a === "arm64") return "aarch64";
  if (a === "x64") return "x86_64";
  return a;
}

/**
 * Downloads a file from `url` to `destPath`, makes it executable, and returns
 * the destination path. Throws on failure.
 */
async function downloadBinary(
  url: string,
  destPath: string,
  label: string,
): Promise<void> {
  console.log(`  ⬇ Downloading ${label}...`);
  await exec("bash", [
    "-c",
    `curl -fsSL -o "${destPath}" "${url}" && chmod +x "${destPath}"`,
  ]);
}

/**
 * Downloads and extracts a `.tar.gz` archive into `destDir`.
 */
async function downloadAndExtract(
  url: string,
  destDir: string,
  label: string,
): Promise<void> {
  console.log(`  ⬇ Downloading ${label}...`);
  await exec("bash", ["-c", `curl -fsSL "${url}" | tar xz -C "${destDir}"`]);
}

/**
 * Installs Docker CLI (and Colima + Lima on macOS) by downloading pre-built
 * binaries directly into ~/.local/bin/. No Homebrew or sudo required.
 */
async function installDockerToolchain(): Promise<void> {
  const isMac = platform() === "darwin";
  const isLinux = platform() === "linux";

  mkdirSync(LOCAL_BIN_DIR, { recursive: true });

  const cpuArch = releaseArch();

  if (isLinux) {
    // On Linux, Docker runs natively — only need the Docker CLI.
    console.log(
      "🐳 Docker not found. Installing Docker CLI to ~/.local/bin/...",
    );

    const dockerArch = cpuArch === "aarch64" ? "aarch64" : "x86_64";
    const dockerTarUrl = `https://download.docker.com/linux/static/stable/${dockerArch}/docker-27.5.1.tgz`;
    const dockerTmpDir = join(LOCAL_BIN_DIR, ".docker-tmp");
    mkdirSync(dockerTmpDir, { recursive: true });
    try {
      await downloadAndExtract(dockerTarUrl, dockerTmpDir, "Docker CLI");
      await exec("mv", [
        join(dockerTmpDir, "docker", "docker"),
        join(LOCAL_BIN_DIR, "docker"),
      ]);
      chmodSync(join(LOCAL_BIN_DIR, "docker"), 0o755);
    } finally {
      await exec("rm", ["-rf", dockerTmpDir]).catch(() => {});
    }

    if (!existsSync(join(LOCAL_BIN_DIR, "docker"))) {
      throw new Error(
        "docker binary not found after installation. Please install Docker manually: https://docs.docker.com/engine/install/",
      );
    }

    console.log("  ✅ Docker CLI installed to ~/.local/bin/");
    return;
  }

  if (!isMac) {
    throw new Error(
      "Automatic Docker installation is only supported on macOS and Linux. " +
        "Please install Docker manually: https://docs.docker.com/engine/install/",
    );
  }

  console.log(
    "🐳 Docker not found. Installing Docker, Colima, and Lima to ~/.local/bin/...",
  );

  // --- Docker CLI (macOS) ---
  // Docker publishes static binaries at download.docker.com.
  const dockerArch = cpuArch === "aarch64" ? "aarch64" : "x86_64";
  const dockerTarUrl = `https://download.docker.com/mac/static/stable/${dockerArch}/docker-27.5.1.tgz`;
  const dockerTmpDir = join(LOCAL_BIN_DIR, ".docker-tmp");
  mkdirSync(dockerTmpDir, { recursive: true });
  try {
    await downloadAndExtract(dockerTarUrl, dockerTmpDir, "Docker CLI");
    // The archive extracts to docker/docker — move it to our bin dir.
    await exec("mv", [
      join(dockerTmpDir, "docker", "docker"),
      join(LOCAL_BIN_DIR, "docker"),
    ]);
    chmodSync(join(LOCAL_BIN_DIR, "docker"), 0o755);
  } finally {
    await exec("rm", ["-rf", dockerTmpDir]).catch(() => {});
  }

  // --- Colima ---
  const colimaArch = cpuArch === "aarch64" ? "arm64" : "x86_64";
  const colimaUrl = `https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${colimaArch}`;
  await downloadBinary(colimaUrl, join(LOCAL_BIN_DIR, "colima"), "Colima");

  // --- Lima ---
  // Lima publishes tar.gz archives with bin/limactl and other tools.
  const limaArch = cpuArch === "aarch64" ? "arm64" : "x86_64";
  const limaVersionUrl =
    "https://api.github.com/repos/lima-vm/lima/releases/latest";
  let limaVersion: string;
  try {
    const resp = await fetch(limaVersionUrl);
    if (!resp.ok) {
      throw new Error(
        `GitHub API returned ${resp.status}` +
          (resp.status === 403
            ? " (rate-limited) — try again later."
            : `. Check your network connection.`),
      );
    }
    const data = (await resp.json()) as { tag_name?: string };
    if (!data.tag_name) {
      throw new Error("GitHub API response missing tag_name.");
    }
    limaVersion = data.tag_name; // e.g. "v1.0.3"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch latest Lima version: ${message}`);
  }
  const limaVersionNum = limaVersion.replace(/^v/, ""); // "1.0.3"
  const limaTarUrl = `https://github.com/lima-vm/lima/releases/download/${limaVersion}/lima-${limaVersionNum}-Darwin-${limaArch}.tar.gz`;
  // Lima archives contain bin/limactl, bin/lima, share/lima/..., so extract
  // into the parent (~/.local/) so that limactl lands in ~/.local/bin/.
  const localDir = dirname(LOCAL_BIN_DIR);
  await downloadAndExtract(limaTarUrl, localDir, "Lima");

  // Verify all binaries are in place.
  for (const bin of ["docker", "colima", "limactl"]) {
    if (!existsSync(join(LOCAL_BIN_DIR, bin))) {
      throw new Error(
        `${bin} binary not found after installation. Please install Docker manually.`,
      );
    }
  }

  console.log("  ✅ Docker toolchain installed to ~/.local/bin/");
}

export type DockerProviderCredentialSetupAction =
  | "configure"
  | "defer"
  | "missing-token"
  | "skip";

export function resolveDockerProviderCredentialSetupAction(options: {
  provider: string | null | undefined;
  guardianAccessToken?: string;
  detached: boolean;
  /**
   * Key — or an explicit skip ("") — collected from the user right after
   * they picked the provider. When present (even empty), the user already
   * answered at the prompt, so detached hatches configure (or report the
   * missing key) instead of deferring to a second `cadet setup` run.
   */
  precollectedKey?: string;
}): DockerProviderCredentialSetupAction {
  if (options.provider === undefined) return "skip";
  if (options.provider === null) return options.detached ? "skip" : "configure";
  if (options.detached) {
    if (options.precollectedKey !== undefined) {
      return options.guardianAccessToken ? "configure" : "missing-token";
    }
    return "defer";
  }
  if (!options.guardianAccessToken) return "missing-token";
  return "configure";
}

/**
 * Checks whether the `docker` CLI and daemon are available on the system.
 * Installs Colima and Docker via direct binary download if missing (no sudo
 * required), and starts Colima if the Docker daemon is not reachable.
 */

/**
 * Checks whether the `docker` CLI and daemon are available on the system.
 * Installs Colima and Docker via direct binary download if missing (no sudo
 * required), and starts Colima if the Docker daemon is not reachable.
 */
export async function ensureDockerInstalled(): Promise<void> {
  // Always add ~/.local/bin to PATH so previously installed binaries are found.
  ensureLocalBinOnPath();

  const isLinux = platform() === "linux";

  // On Linux, Docker runs natively — only need the docker CLI + daemon.
  // On macOS, we also need Colima and Lima to provide a Linux VM.
  const toolchainComplete = await (async () => {
    try {
      await execOutput("docker", ["--version"]);
      if (!isLinux) {
        await execOutput("colima", ["version"]);
        await execOutput("limactl", ["--version"]);
      }
      return true;
    } catch {
      return false;
    }
  })();

  if (!toolchainComplete) {
    await installDockerToolchain();
    // Re-check PATH after install.
    ensureLocalBinOnPath();

    try {
      await execOutput("docker", ["--version"]);
    } catch {
      throw new Error(
        "Docker was installed but is still not available on PATH. " +
          "You may need to restart your terminal.",
      );
    }
  }

  // Verify the Docker daemon is reachable.
  try {
    await exec("docker", ["info"]);
  } catch {
    // On Linux, the daemon must already be running (systemd, etc.).
    if (isLinux) {
      throw new Error(
        "Docker daemon is not running. Please start it with 'sudo systemctl start docker' " +
          "or ensure the Docker service is enabled.",
      );
    }

    // On macOS, try starting Colima.
    let hasColima = false;
    try {
      await execOutput("colima", ["version"]);
      hasColima = true;
    } catch {
      // colima not found
    }

    if (!hasColima) {
      throw new Error(
        "Docker daemon is not running and Colima is not installed.\n" +
          "Please start Docker Desktop, or install Colima with 'brew install colima' and run 'colima start'.",
      );
    }

    console.log("🚀 Docker daemon not running. Starting Colima...");
    await startColimaAndAwaitDaemon({
      startArgs: ["--memory", String(COLIMA_DEFAULT_MEMORY_GIB)],
    });
  }
}

/** Silently attempt to stop and remove a Docker container. */

/**
 * Error signatures Docker Hub returns when the host has STALE Docker Hub
 * credentials: an expired personal access token saved by a past
 * `docker login` gets attached to the pull, and Hub rejects the request
 * instead of falling back to anonymous access for a public image.
 */
function isExpiredDockerHubCredentialError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /personal access token is expired|authentication required|unauthorized/i.test(
    message,
  );
}

/**
 * Pull an image, retrying once without stale credentials when Docker Hub
 * rejects the pull with an expired-token/auth error — public pulls need no
 * login, so `docker logout` (clears the stored Docker Hub credentials the
 * docker CLI attaches to pulls) costs nothing. Other failures propagate raw;
 * a still-failing auth retry is rethrown with actionable copy.
 */
export async function pullImage(
  ref: string,
  log: (msg: string) => void = console.log,
  execFn: typeof exec = exec,
): Promise<void> {
  try {
    await execFn("docker", ["pull", ref]);
    return;
  } catch (err) {
    if (!isExpiredDockerHubCredentialError(err)) throw err;
    log(
      `⚠️  Docker Hub rejected the pull of ${ref} with an expired-credential ` +
        `error — clearing stale Docker Hub login and retrying (public images ` +
        `need no credentials)...`,
    );
    await execFn("docker", ["logout"]).catch(() => {});
  }
  try {
    await execFn("docker", ["pull", ref]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to pull ${ref}.\n${message}\n` +
        `If the Docker daemon is not running, start it, e.g. 'colima start' on macOS. ` +
        `If the error mentions authentication, run 'docker logout' and check your ` +
        `Docker Hub credentials — public image pulls need none.`,
    );
  }
}

/**
 * Walk up from `startDir` looking for a directory that contains
 * `assistant/Dockerfile`. Returns the path if found, otherwise `undefined`.
 */
function walkUpForRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "assistant", "Dockerfile"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Returns `true` when the given root looks like a full source checkout
 * (has assistant source code), as opposed to a packaged `.app` bundle
 * that only contains the Dockerfiles.
 */
function hasFullSourceTree(root: string): boolean {
  return existsSync(join(root, "assistant", "package.json"));
}

/**
 * Decide which image-source path `hatchDocker` should take given the user
 * flags and a probe result for the source tree.
 *
 * - `watch` always wants source-build *and* file-watcher (when the source
 *   tree is available).
 * - `buildFromSource` wants source-build but no watcher — used by evals so
 *   each run picks up fresh CLI changes from the repo.
 * - Without either flag we pull the published images.
 * - If either flag was set but the source tree is missing (e.g. the CLI is
 *   running from a packaged .app bundle), fall back to pulling and surface
 *   the reason so the caller can log a warning.
 *
 * Returning a plain record keeps this trivially unit-testable — see
 * `__tests__/remotes-docker-hatch.test.ts`.
 */
export function resolveDockerHatchMode(opts: {
  watch: boolean;
  buildFromSource: boolean;
  fullSourceTreeAvailable: boolean;
}): { build: boolean; watcher: boolean; fellBackToPull: boolean } {
  const requested = opts.watch || opts.buildFromSource;
  if (!requested) {
    return { build: false, watcher: false, fellBackToPull: false };
  }
  if (!opts.fullSourceTreeAvailable) {
    return { build: false, watcher: false, fellBackToPull: true };
  }
  return { build: true, watcher: opts.watch, fellBackToPull: false };
}

/**
 * Locate the repository root by walking up from `cli/src/lib/` until we
 * find a directory containing the expected Dockerfiles.
 */
function findRepoRoot(): string {
  // cli/src/lib/ -> repo root (works when running from source via bun)
  const sourceTreeRoot = join(import.meta.dir, "..", "..", "..");
  if (existsSync(join(sourceTreeRoot, "assistant", "Dockerfile"))) {
    return sourceTreeRoot;
  }

  // Walk up from the compiled binary's location. When the CLI is bundled
  // inside the macOS app (e.g. .../dist/Cadet.app/Contents/MacOS/cadet-cli),
  // the binary still lives inside the repo tree, so walking up will
  // eventually reach the repo root.
  const execRoot = walkUpForRepoRoot(dirname(process.execPath));
  if (execRoot) {
    return execRoot;
  }

  // Check the app bundle's Resources directory. Debug DMG builds bundle
  // Dockerfiles at Contents/Resources/dockerfiles/{assistant,gateway,...}/Dockerfile.
  // The CLI binary lives at Contents/MacOS/cadet-cli, so Resources is at
  // ../Resources relative to the binary.
  const bundledRoot = join(
    dirname(process.execPath),
    "..",
    "Resources",
    "dockerfiles",
  );
  if (existsSync(join(bundledRoot, "assistant", "Dockerfile"))) {
    return bundledRoot;
  }

  // Walk up from cwd as a final fallback
  const cwdRoot = walkUpForRepoRoot(process.cwd());
  if (cwdRoot) {
    return cwdRoot;
  }

  throw new Error(
    "Could not find repository root containing assistant/Dockerfile. " +
      "Run this command from within the mycadet repository.",
  );
}

async function buildAllImages(
  repoRoot: string,
  imageTags: Record<ServiceName, string>,
  log: (msg: string) => void,
): Promise<void> {
  const configs = serviceImageConfigs(repoRoot, imageTags);
  log("🔨 Building all images in parallel...");
  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      await buildImage(config);
      log(`✅ ${name} built`);
    }),
  );
}

export interface HatchDockerParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  /**
   * The provider the caller's interactive flow settled on. `undefined` =
   * skip provider credential setup entirely (internal hatches); `null` =
   * setup enabled but no provider chosen.
   */
  provider?: string | null;
  /**
   * Key — or an explicit skip ("") — collected from the user right after
   * they picked the provider. Configured right after the guardian token
   * leases, while the choice is fresh.
   */
  precollectedApiKey?: string;
  /**
   * Create the three containers without starting them and persist the entry
   * without waiting for readiness — the teleport's initialize-data half. The
   * caller installs the transferred archive into the created volumes and
   * wakes; a hatch is just initialize-data + wake, and the teleport owns
   * both halves itself.
   */
  createOnly?: boolean;
  /**
   * The CLI's release version — owns the Docker Hub image resolution (the
   * published images are tagged from it).
   */
  version?: string;
  /**
   * Path to a local source tree to build images from before hatching. When
   * provided, this path is used directly as the repo root and no file
   * watcher is started — useful for callers (e.g. evals) that want each
   * run to pick up local CLI changes without keeping a long-lived watcher
   * process around. `--watch` independently auto-detects the repo root and
   * also enables hot-reload.
   */
  sourcePath?: string | null;
  /**
   * Name of an existing container whose network namespace the assistant,
   * gateway, and credential-executor join (`--network=container:<name>`),
   * instead of the assistant owning a freshly-created per-instance network.
   * When set, hatch creates no Docker network and publishes no host ports —
   * the namespace owner is responsible for publishing the gateway port — so
   * `gatewayPort` must also be supplied (the owner had to publish it before
   * hatch ran).
   */
  netnsContainer?: string;
  /**
   * Explicit host port to record as the entry's gatewayPort instead of
   * auto-allocating a free port. Required alongside `netnsContainer`, where
   * the namespace owner — not hatch — owns port allocation and publishing.
   */
  gatewayPort?: number;
  /**
   * Host path to a PEM CA bundle bind-mounted into the assistant container
   * and trusted at process start via `NODE_EXTRA_CA_CERTS`. Lets the daemon
   * trust a TLS-terminating egress proxy from its very first outbound
   * connection.
   */
  assistantCaCertPath?: string;
  /** The narration sink (defaults to the console reporter). */
  reporter?: LifecycleReporter;
}

export type HatchDockerResult =
  | {
      ok: true;
      entry: DockerAssistant;
      /**
       * False when hatch returned early (createOnly) or the readiness wait
       * timed out in watch mode (where the watcher's rebuilds retry it).
       */
      ready: boolean;
      guardianAccessToken?: string;
    }
  | { ok: false; status: number; error: string; assistantId?: string };

export async function hatchDocker(
  params: HatchDockerParams,
): Promise<HatchDockerResult> {
  const { name = null, configValues = {} } = params;
  let watch = params.watch ?? false;
  const reporter = params.reporter ?? consoleLifecycleReporter;
  const log = (msg: string) => reporter.log(msg);
  const provider = params.provider;
  const precollectedApiKey = params.precollectedApiKey;
  const version = params.version ?? "";
  let instanceName: string | undefined;

  try {
    await ensureDockerInstalled();

    instanceName = generateInstanceName(name);
    // Resolve the gateway's host port. When joining an externally-owned
    // network namespace, the owner has already published the gateway port,
    // so the caller — not hatch — owns port allocation; use the supplied
    // port verbatim. Otherwise resolve it dynamically: the env-default
    // (production 7830 / non-prod overrides) is just the *preferred*
    // starting point — if it's taken by another local assistant, eval run,
    // or unrelated process, we walk upward until we find a free port, so
    // concurrent instances don't collide on a docker bind error.
    let gatewayPort: number;
    if (params.netnsContainer) {
      if (params.gatewayPort === undefined) {
        throw new Error(
          "hatchDocker: gatewayPort is required when netnsContainer is set (the namespace owner publishes the port before hatch runs)",
        );
      }
      gatewayPort = params.gatewayPort;
    } else {
      const preferredGatewayPort = getDefaultPorts().gateway;
      gatewayPort = await findOpenPort(preferredGatewayPort);
      if (gatewayPort !== preferredGatewayPort) {
        log(
          `Preferred gateway port ${preferredGatewayPort} is in use; allocated ${gatewayPort} for this instance.`,
        );
      }
    }

    // Allocate the assistant HTTP API host port. Same dynamic-allocation
    // strategy as the gateway port: the env-default (production 7821 /
    // non-prod overrides) is the *preferred* starting point, and we walk
    // upward until we find a free port. Without this, two concurrent
    // `cadet hatch --remote docker` on the same host collide on a fixed
    // 7821 bind ("port is already allocated"). Unused when netnsContainer
    // is set — no host ports are published in that mode.
    let assistantPort: number;
    if (params.netnsContainer) {
      assistantPort = ASSISTANT_INTERNAL_PORT;
    } else {
      const preferredAssistantPort = getDefaultPorts().daemon;
      assistantPort = await findOpenPort(preferredAssistantPort, {
        exclude: [gatewayPort],
      });
      if (assistantPort !== preferredAssistantPort) {
        log(
          `Preferred assistant port ${preferredAssistantPort} is in use; allocated ${assistantPort} for this instance.`,
        );
      }
    }

    const imageTags: Record<ServiceName, string> = {
      assistant: "",
      "credential-executor": "",
      gateway: "",
    };

    const sourcePath =
      typeof params.sourcePath === "string" && params.sourcePath.length > 0
        ? params.sourcePath
        : null;
    const buildFromSource = sourcePath !== null;
    let repoRoot: string | undefined;
    let fullSourceTreeAvailable = false;

    if (watch || buildFromSource) {
      // When --source <path> is supplied, trust the caller and use it
      // directly. Otherwise (the --watch case) walk up from known locations
      // to find the repo root.
      repoRoot = sourcePath ? resolve(sourcePath) : findRepoRoot();

      // When running from a packaged .app bundle, the Dockerfiles are
      // present (so findRepoRoot succeeds) but the full source tree is
      // not — we can't build images locally. Fall back to pulling
      // pre-built images instead.
      fullSourceTreeAvailable = hasFullSourceTree(repoRoot);
      if (!fullSourceTreeAvailable) {
        log(
          "⚠️  Dockerfiles found but no source tree — falling back to image pull",
        );
        repoRoot = undefined;
      }
    }

    const mode = resolveDockerHatchMode({
      watch,
      buildFromSource,
      fullSourceTreeAvailable,
    });
    // Honour the resolved mode for the rest of the flow.
    watch = mode.watcher;

    if (mode.build && repoRoot) {
      const localTag = `local-${instanceName}`;
      imageTags.assistant = `mycadet:${localTag}`;
      imageTags.gateway = `cadet-gateway:${localTag}`;
      imageTags["credential-executor"] =
        `cadet-credential-executor:${localTag}`;

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(
        `   Mode: ${mode.watcher ? "development (watch)" : "build-from-source"}`,
      );
      log(`   Repo: ${repoRoot}`);
      log(`   Images (local build):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      await buildAllImages(repoRoot, imageTags, log);
      log("✅ Docker images built");
    }

    if (!mode.build || !repoRoot) {
      // Allow explicit image overrides via environment variables.
      // When all three are set, skip version-based resolution entirely.
      const envAssistant = process.env.CADET_ASSISTANT_IMAGE;
      const envGateway = process.env.CADET_GATEWAY_IMAGE;
      const envCredentialExecutor = process.env.CADET_CREDENTIAL_EXECUTOR_IMAGE;

      let imageSource: string;

      if (envAssistant && envGateway && envCredentialExecutor) {
        imageTags.assistant = envAssistant;
        imageTags.gateway = envGateway;
        imageTags["credential-executor"] = envCredentialExecutor;
        imageSource = "env override";
        log("Using image overrides from environment variables");
      } else {
        log(`🔍 Resolving image references from CLI version...`);
        const resolved = resolveOwnImageRefs(version);
        imageTags.assistant = resolved.assistant;
        imageTags.gateway = resolved.gateway;
        imageTags["credential-executor"] = resolved["credential-executor"];
        imageSource = "dockerhub";
      }

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(`   Images (${imageSource}):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      // Per-ref branching: local-build refs need the image-loader; external
      // registry refs get a normal `docker pull`. The two transports compose
      // cleanly — a release can mix different sources for different images.
      log("📦 Acquiring Docker images...");
      for (const service of [
        "assistant",
        "gateway",
        "credential-executor",
      ] as const) {
        const ref = imageTags[service];
        if (isLocalBuildRef(ref)) {
          log(`   ↪ loading ${ref} via host image-loader`);
          await loadImageViaHost(HOST_IMAGE_LOADER_URL, ref, log);
        } else {
          log(`   ↪ pulling ${ref}`);
          const MAX_PULL_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_PULL_RETRIES; attempt++) {
            try {
              await pullImage(ref, log);
              break;
            } catch (err) {
              if (attempt === MAX_PULL_RETRIES) throw err;
              const delaySec = 2 ** attempt;
              log(
                `   ⚠ pull failed (attempt ${attempt}/${MAX_PULL_RETRIES}), retrying in ${delaySec}s...`,
              );
              await new Promise((r) => setTimeout(r, delaySec * 1000));
            }
          }
        }
      }
      log("✅ Docker images acquired");
    }

    const res = dockerResourceNames(instanceName);
    // When joining an externally-owned network namespace, the owner already
    // provides the network stack — creating a per-instance network here would
    // be unused and leak on teardown.
    if (params.netnsContainer) {
      log("📁 Joining existing network namespace; creating volumes...");
    } else {
      log("📁 Creating network and volumes...");
      await exec("docker", ["network", "create", res.network]);
    }
    await exec("docker", ["volume", "create", res.socketVolume]);
    await exec("docker", ["volume", "create", res.assistantIpcVolume]);
    await exec("docker", ["volume", "create", res.gatewayIpcVolume]);
    await exec("docker", ["volume", "create", res.workspaceVolume]);
    await exec("docker", ["volume", "create", res.cesSecurityVolume]);
    await exec("docker", ["volume", "create", res.gatewaySecurityVolume]);

    // Set volume ownership so non-root containers (UID 1001) can write.
    await exec("docker", [
      "run",
      "--rm",
      "-v",
      `${res.workspaceVolume}:/workspace`,
      "-v",
      `${res.assistantIpcVolume}:/run/assistant-ipc`,
      "-v",
      `${res.gatewayIpcVolume}:/run/gateway-ipc`,
      "busybox",
      "sh",
      "-c",
      "chown 1001:1001 /workspace /run/assistant-ipc /run/gateway-ipc",
    ]);

    // Stage the BYOK default-workspace-config overlay *inside* the workspace
    // volume so the daemon's startup loader can consume it. The loader
    // (`mergeDefaultWorkspaceConfig` in assistant/src/config/loader.ts) does:
    //   1. JSON.parse + deep-merge into the workspace's config.json.
    //   2. `renameSync(defaultConfigPath, <workspace>/default-config.json)`
    //      to mark the overlay consumed so subsequent restarts skip it.
    //
    // The rename must be same-filesystem. Bind-mounting the host file into
    // `/tmp/...` (the pre-#32025 design) crossed filesystems and silently
    // failed with EXDEV, so every `docker start` re-applied the overlay.
    // Staging into the workspace volume keeps the rename in-place.
    //
    // Streaming the JSON via stdin (instead of bind-mounting the host file
    // into the staging container) sidesteps macOS Colima's virtiofs share,
    // which doesn't expose `/var/folders/...` (where `os.tmpdir()` resolves
    // on macOS) and would otherwise materialize an empty directory at the
    // bind-mount target.
    //
    // @deprecated stopgap. Replacement direction is one of:
    //   1. Post-hatch API calls (POST /v1/secrets + a small endpoint that
    //      returns canonical inference-profile templates).
    //   2. Move inference-profile seeds out of workspace config and into
    //      Assistant code, eliminating the overlay entirely.
    // See `cli/src/lib/config-utils.ts` JSDoc for context.
    const hatchConfigValues = buildHatchConfigValues(configValues, provider);
    const hostOverlayPath = writeInitialConfig(hatchConfigValues);
    const stagedOverlayInContainer = "/workspace/.default-config-overlay.json";
    const extraAssistantEnv: Record<string, string> = {};
    if (hostOverlayPath) {
      await execWithStdin(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "-v",
          `${res.workspaceVolume}:/workspace`,
          "busybox",
          "sh",
          "-c",
          `cat > ${stagedOverlayInContainer} && chown 1001:1001 ${stagedOverlayInContainer}`,
        ],
        readFileSync(hostOverlayPath, "utf-8"),
      );
      extraAssistantEnv.CADET_DEFAULT_WORKSPACE_CONFIG_PATH =
        stagedOverlayInContainer;
    }

    const cesServiceToken = randomBytes(32).toString("hex");

    const hostDeviceId = getOrCreateHostDeviceId();
    extraAssistantEnv.CADET_DEVICE_ID = hostDeviceId;
    // Forward the migration URL allowlists so a daemon inside the container
    // can PUT/GET teleport bundles against a local (non-GCS) platform.
    // Pass-through only: unset in normal use, preserving the strict
    // GCS-only validator default. A containerized daemon reaches the host
    // via host.docker.internal, so that is the value to export when
    // teleporting docker assistants against a local platform.
    for (const key of [
      "CADET_MIGRATION_EXPORT_ALLOWED_HOSTS",
      "CADET_MIGRATION_IMPORT_ALLOWED_HOSTS",
    ] as const) {
      const value = process.env[key];
      if (value) {
        extraAssistantEnv[key] = value;
      }
    }
    const extraGatewayEnv = {
      CADET_DEVICE_ID: hostDeviceId,
    };
    const gatewayUrl = `http://localhost:${gatewayPort}`;
    const dockerEntry: LockfileAssistant = {
      assistantId: instanceName,
      port: gatewayPort,
      daemonPort: assistantPort,
      cloud: "docker",
      hatchedAt: new Date().toISOString(),
      containerInfo: {
        assistantImage: imageTags.assistant,
        gatewayImage: imageTags.gateway,
        cesImage: imageTags["credential-executor"],
      },
    };
    if (params.createOnly) {
      saveLockfileAssistant(dockerEntry);
    }
    await startContainers(
      {
        assistantMemory: dockerEntry.machine?.memory ?? null,
        createOnly: !!params.createOnly,
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        imageTags,
        instanceName,
        res,
        netnsContainer: params.netnsContainer,
        assistantCaCertPath: params.assistantCaCertPath,
      },
      log,
    );
    const containersUpAt = Date.now();
    // The active-assistant switch rides the same locked write.
    saveLockfileAssistant(dockerEntry, instanceName);

    if (params.createOnly) {
      // The teleport's initialize-data half: containers exist (created, not
      // started) and the entry is persisted — the caller installs the
      // transferred archive into the volumes and wakes.
      return { ok: true, entry: dockerEntry, ready: false };
    }
    // Hatch always detaches; only watch mode keeps the log stream attached.
    const waitDetached = !watch;
    const { ready, guardianAccessToken, notReadyReason } =
      await waitForGatewayAndLease({
        entry: dockerEntry,
        containerName: res.assistantContainer,
        detached: waitDetached,
        instanceName,
        log,
        containersUpAt,
      });

    if (!ready && !(watch && repoRoot)) {
      return {
        ok: false,
        status: 500,
        error:
          notReadyReason === "migrations_failed"
            ? "Assistant database migrations failed — the container is running but DB-backed routes are unavailable; check its logs and restore a backup or retry the migration"
            : "Timed out waiting for assistant to become ready",
        assistantId: instanceName,
      };
    }

    if (ready) {
      const providerSetupAction = resolveDockerProviderCredentialSetupAction({
        provider,
        guardianAccessToken,
        detached: waitDetached,
        precollectedKey: precollectedApiKey,
      });

      if (providerSetupAction === "defer" && provider !== null) {
        log(
          `Provider credential setup deferred in detached mode.\n` +
            `Run \`cadet setup --provider ${provider}\` after the assistant is ready.`,
        );
      } else if (providerSetupAction === "missing-token" && provider !== null) {
        log(
          `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
            `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the connection.`,
        );
      } else if (
        providerSetupAction === "configure" &&
        provider !== undefined
      ) {
        await configureHatchProviderApiKey({
          gatewayUrl,
          provider,
          bearerToken: guardianAccessToken,
          env: process.env,
          precollectedKey: precollectedApiKey,
          log,
        });
      }
    }

    if (watch && repoRoot) {
      const watching: LockfileAssistant = {
        ...dockerEntry,
        watcherPid: process.pid,
      };
      saveLockfileAssistant(watching);
      const stopWatcher = startFileWatcher({
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        imageTags,
        instanceName,
        repoRoot,
        res,
        netnsContainer: params.netnsContainer,
        assistantCaCertPath: params.assistantCaCertPath,
      });

      await new Promise<void>((resolve) => {
        const cleanup = async () => {
          log("\n🛑 Shutting down...");
          stopWatcher();
          await stopContainers(res);
          const unwatched: LockfileAssistant = {
            ...dockerEntry,
            watcherPid: undefined,
          };
          saveLockfileAssistant(unwatched);
          log("✅ Docker instance stopped.");
          resolve();
        };

        // SIGINT (Ctrl+C): full cleanup including stopping containers.
        process.on("SIGINT", () => void cleanup());

        // SIGTERM (from `cadet retire`): exit quickly — the caller
        // handles container teardown, so we only need to close the
        // file watchers and let the process terminate.
        process.on("SIGTERM", () => {
          stopWatcher();
          saveLockfileAssistant({
            ...dockerEntry,
            watcherPid: undefined,
          });
          resolve();
        });
      });
    }

    return { ok: true, entry: dockerEntry, ready, guardianAccessToken };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
      assistantId: instanceName,
    };
  }
}
/**
 * In detached mode, print instance details and return immediately.
 * Otherwise, poll the gateway health check until it responds, then
 * lease a guardian token.
 */
async function waitForGatewayAndLease(opts: {
  entry: LockfileAssistant;
  containerName: string;
  detached: boolean;
  instanceName: string;
  log: (msg: string) => void;
  containersUpAt: number;
}): Promise<{
  ready: boolean;
  guardianAccessToken?: string;
  /** Present when readiness was not reached because migrations terminally
   * failed (returned in seconds, unlike an actual timeout). */
  notReadyReason?: "migrations_failed";
}> {
  const { entry, containerName, detached, instanceName, log, containersUpAt } =
    opts;
  const gatewayUrl = getGatewayUrl(entry);

  if (detached) {
    // Lease a guardian token BEFORE declaring the assistant hatched so the
    // banner means `cadet ps`, `cadet exec`, and other CLI commands can
    // already authenticate. Skip the /readyz readiness poll (the caller
    // asked to detach and not block) but retry the lease silently since
    // the gateway may need a moment to accept connections after the
    // container starts; only a final failure surfaces to the user.
    const leaseDeadline = containersUpAt + DOCKER_READY_TIMEOUT_MS;
    let guardianAccessToken: string | undefined;
    while (Date.now() < leaseDeadline) {
      try {
        const tokenData = await leaseGuardianToken(entry);
        guardianAccessToken = tokenData.accessToken;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!guardianAccessToken) {
      log(
        `⚠️  Guardian token lease failed after ${DOCKER_READY_TIMEOUT_MS / 1000}s.\n` +
          `   The assistant is running but CLI commands (cadet ps, cadet exec) will not authenticate.\n` +
          `   Re-hatch or run \`cadet setup\` to recover.`,
      );
    }

    return { ready: true, guardianAccessToken };
  }

  log(`  Container: ${containerName}`);
  log(`  Runtime: ${gatewayUrl}`);
  log("");
  log("Waiting for assistant to become ready...");

  const readyUrl = `${gatewayUrl}/readyz`;
  const start = containersUpAt;
  let ready = false;
  let migrationsFailed = false;

  // Readiness is classified from the /readyz BODY: the assistant returns 200
  // with `ready: false` while DB migrations run (the k8s keep-the-pod
  // contract), so `resp.ok` alone would declare readiness mid-migration and
  // the guardian token lease below would burn its shared budget against the
  // gateway's still-closed traffic gate.
  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await loopbackSafeFetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json().catch(() => null)) as {
        status?: string;
        upstream?: number;
      } | null;
      const readiness = classifyReadyzResponse(resp.ok, body);
      if (readiness === "ready") {
        ready = true;
        break;
      }
      if (readiness === "failed") {
        migrationsFailed = true;
        break;
      }
      const parts = [body?.status].filter(Boolean);
      if (body?.upstream != null) parts.push(`upstream=${body.upstream}`);
      const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
      log(`Readiness check: ${resp.status}${detail} (retrying...)`);
    } catch {
      // Connection refused / timeout — not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    log("");
    if (migrationsFailed) {
      log(`   \u26a0\ufe0f  Assistant database migrations FAILED.`);
    } else {
      log(`   \u26a0\ufe0f  Timed out waiting for assistant to become ready.`);
    }
    log(`   The container is still running.`);
    log(`   Check logs with: docker logs -f ${containerName}`);
    log("");
    return {
      ready: false,
      ...(migrationsFailed
        ? { notReadyReason: "migrations_failed" as const }
        : {}),
    };
  }

  const readyAt = Date.now();
  const containersUpToReadyMs = readyAt - start;
  const elapsedSec = (containersUpToReadyMs / 1000).toFixed(1);
  log(`Assistant ready after ${elapsedSec}s`);
  console.info(
    `[cadet-hatch-timing] ${JSON.stringify({
      containers_up_to_ready_ms: containersUpToReadyMs,
      instance: instanceName,
    })}`,
  );

  // Lease guardian token. The /readyz check confirms both gateway and
  // assistant are reachable. Retry with backoff in case there is a brief
  // window where readiness passes but the guardian endpoint is not yet ready.
  const leaseStart = Date.now();
  const leaseDeadline = start + DOCKER_READY_TIMEOUT_MS;
  let leaseSuccess = false;
  let lastLeaseError: string | undefined;
  let guardianAccessToken: string | undefined;

  while (Date.now() < leaseDeadline) {
    try {
      const tokenData = await leaseGuardianToken(entry);
      guardianAccessToken = tokenData.accessToken;
      leaseSuccess = true;
      break;
    } catch (err) {
      lastLeaseError =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!leaseSuccess) {
    log(
      `\u26a0\ufe0f  Guardian token lease: FAILED after ${(
        (Date.now() - leaseStart) /
        1000
      ).toFixed(1)}s — ${lastLeaseError ?? "unknown error"}`,
    );
  }

  log("");
  log("✅ Docker containers are up and running!");
  log("");
  return { ready: true, guardianAccessToken };
}

/**
 * Mint (and approve) a remote-web pairing challenge inside the gateway
 * container — the docker topology's `gateway pairing mint`. Returns the
 * command's stdout; its last line is the challenge JSON.
 */
