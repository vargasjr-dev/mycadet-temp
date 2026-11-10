/**
 * Baseten sandbox manager for Cadet QA — one image, session-shaped.
 *
 * `cadet-qa` (this directory's Dockerfile) carries the toolchain and the
 * open-source repo pulled into /qa at build time. A QA session is a sandbox
 * from that image: create one, exec inside it, delete it. Desktop, Android,
 * or web is a choice made inside the session (the README cheatsheet has the
 * commands), not a verb here.
 *
 * Usage:
 *
 *   bun qa/index.ts image push
 *   bun qa/index.ts create --name qa-desktop-1108
 *   bun qa/index.ts exec --name qa-desktop-1108 -- <command>...
 *   bun qa/index.ts delete --name qa-desktop-1108
 *
 * Create publishes the cadet-qa VOLUME first (the repo, its installs, both
 * prebuilt client dists, and the boot seed) and mounts it at /qa — see the
 * volume note below for why the sandbox's own disk can't carry that tree.
 *
 * The Baseten CLI authenticates from BASETEN_API_KEY (vaulted as
 * baseten:api_key — pass it in the environment, never bake it into the
 * image).
 */

import { mkdtemp as fsMkdtemp, mkdir as fsMkdir, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BASETEN_API_KEY_ENV,
  runBaseten,
} from "@mycadet/shared/providers/baseten";

const QA_IMAGE_NAME = "cadet-qa";
const QA_IMAGE_REF = `sandbox/${QA_IMAGE_NAME}:latest`;

/**
 * The sandbox volume the QA tree rides on, mounted at /qa over the image's
 * build-time clone. The volume carries what the RAM-limited overlay cannot:
 * node_modules (with the Playwright browser in it), both prebuilt client
 * dists, and the state seed below — so a session starts warm instead of
 * installing and building on the sandbox's memory-backed disk (which wedges
 * at the 4GB account ceiling).
 */
const QA_VOLUME_NAME = "cadet-qa";
const QA_VOLUME_MOUNT_PATH = "/qa";
const QA_VOLUME_NAMESPACE_ENV = "BASETEN_VOLUME_NAMESPACE";

/** The account ceiling on sandbox memory — Baseten rejects bigger creates with a 429. */
const QA_SANDBOX_MEMORY_MB = 4096;

/** The app-server port the state seed stamps — the CLI's own default (servers/common.ts). */
const QA_APP_SERVER_PORT = 7840;

/** Assemble the `baseten sandbox image push` argv. Exported for the tests. */
export function buildImagePushArgs(options: { wait?: boolean } = {}): string[] {
  return [
    "sandbox",
    "image",
    "push",
    "--name",
    QA_IMAGE_NAME,
    "--dir",
    import.meta.dir,
    ...(options.wait ?? true ? ["--wait"] : []),
  ];
}

/** Assemble the `baseten sandbox create` argv. Exported for the tests. */
export function buildCreateArgs(options: { name: string }): string[] {
  // The platform default is baseten/base-image — a bare sandbox with no QA
  // toolchain — so create always pins the pushed cadet-qa image, and memory
  // sits at the account ceiling. One image, one size: the same every time.
  // The volume mounts the QA tree at /qa (shadowing the image's bare clone),
  // so every session boots with deps and dists already in place.
  return [
    "sandbox",
    "create",
    "--name",
    options.name,
    "--image",
    QA_IMAGE_REF,
    "--volume",
    `${QA_VOLUME_NAME}:${QA_VOLUME_MOUNT_PATH}`,
    "--memory",
    String(QA_SANDBOX_MEMORY_MB),
  ];
}

/**
 * Resolve the `bdn:` ref a volume push publishes to. Baseten namespaces are
 * caller-chosen labels (any push creates one), so the default is ours; the
 * env overrides for a different account.
 */
export function resolveVolumeRef(namespace?: string): string {
  const ns = namespace ?? process.env[QA_VOLUME_NAMESPACE_ENV] ?? "vargas-jr";
  return `bdn:${ns}/${QA_VOLUME_NAME}:qa`;
}

/** Assemble the `baseten volume push` argv. Exported for the tests. */
export function buildVolumePushArgs(options: { dir: string; ref: string }): string[] {
  return ["volume", "push", options.dir, options.ref];
}

/**
 * The lockfile seed stamped into a fresh sandbox's root config at boot: an
 * `app` record whose builtSha matches the tree's HEAD, so `cadet app start`
 * reads the prebuilt dists as fresh and skips the session-time build (the
 * build is what wedges the sandbox — the point of the volume). The `port`
 * matches the app server's default, which `cadet app start` picks on a
 * quiet sandbox.
 */
export function buildQaLockfileSeed(headSha: string): string {
  return `${JSON.stringify(
    {
      assistants: [],
      activeAssistant: null,
      app: { port: QA_APP_SERVER_PORT, builtSha: headSha },
    },
    null,
    2,
  )}\n`;
}

/** Assemble the `baseten sandbox exec` argv. Exported for the tests. */
export function buildExecArgs(options: {
  name: string;
  command: string[];
}): string[] {
  return ["sandbox", "exec", "--name", options.name, "--", ...options.command];
}

/**
 * The Baseten CLI authenticates from the env key for scripted use — check
 * before the first call so a session fails fast with the fix, not mid-flight.
 */
function requireApiKey(): void {
  if (!process.env[BASETEN_API_KEY_ENV]) {
    throw new Error(
      `${BASETEN_API_KEY_ENV} is not set — the Baseten CLI authenticates ` +
        `from it (vaulted as baseten:api_key; never commit it).`,
    );
  }
}

function pushImage(options: { wait?: boolean } = {}): void {
  requireApiKey();
  runBaseten(buildImagePushArgs(options), "Image push failed");
}

/**
 * Assemble the QA tree a volume push publishes: a fresh clone of the repo's
 * default branch, a full install (scripts on — the generated openapi client
 * and the Playwright browser both arrive this way), both client dists
 * prebuilt (the same `bun run build` the app server would run at session
 * time — run HERE, where memory isn't the ceiling), and `.qa-state/` with
 * the boot seed. Returns the assembled directory; the caller hands it to
 * `baseten volume push`.
 */
async function assembleQaVolumeTree(options: {
  repoUrl?: string;
}): Promise<string> {
  // The whole assembly runs CI-mode: the postinstall keeps the electron
  // packaging armada (its prune is what leaves dangling .bin symlinks the
  // volume pusher's tree scan rejects), and so does the nested install the
  // app build script runs. Passed explicitly on every spawn — bun's
  // spawnSync does not reliably inherit process.env mutations.
  const ciEnv = { ...process.env, CI: "true" };
  const repoUrl = options.repoUrl ?? "https://github.com/vargasjr-dev/mycadet-temp.git";
  const tmpRoot = await fsMkdtemp(join(tmpdir(), "qa-volume-"));
  const tree = join(tmpRoot, "qa");
  const runChecked = (command: string[], cwd: string, label: string) => {
    console.log(`[qa volume] ${label}...`);
    const result = Bun.spawnSync(command, {
      cwd,
      env: ciEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(`${label} failed (exit ${result.exitCode})`);
    }
  };
  runChecked(["git", "clone", "--depth", "1", repoUrl, tree], tmpRoot, "clone");
  const headSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: tree,
    env: ciEnv,
  }).stdout.toString().trim();
  if (!headSha) throw new Error("could not read the clone's HEAD sha");
  runChecked(["bun", "install"], tree, "install");
  runChecked(["bun", "run", "build"], join(tree, "clients/web"), "build web");
  runChecked(["bun", "run", "build"], join(tree, "clients/app"), "build app");
  // The boot seed: the entrypoint runs this in the sandbox before any exec,
  // stamping the prebuilt dists as fresh so `cadet app start` skips its build.
  const seedDir = join(tree, ".qa-state");
  await fsMkdir(seedDir, { recursive: true });
  await fsWriteFile(
    join(seedDir, "cadet-lockfile.json"),
    buildQaLockfileSeed(headSha),
  );
  await fsWriteFile(
    join(seedDir, "seed-state.ts"),
    [
      "// Generated by `bun qa/index.ts create` — stamps the tree's",
      "// prebuilt dists as fresh so `cadet app start` skips its build.",
      'import { stampRootProcess } from "../cli/src/lib/assistant-config";',
      `stampRootProcess("app", { port: ${QA_APP_SERVER_PORT}, builtSha: ${JSON.stringify(headSha)} });`,
      "",
    ].join("\n"),
  );
  console.log(`[qa volume] assembled ${tree} at ${headSha}`);
  return tmpRoot;
}

/**
 * Publish the QA tree to the volume the create mounts: assemble it (clone →
 * install → both client builds → boot seed), push it, and clean up. Runs on
 * every create — pushes are content-deduplicated, so a tree that mostly
 * matches the published version uploads only what changed.
 */
async function pushQaVolume(): Promise<void> {
  const tmpRoot = await assembleQaVolumeTree({});
  try {
    const ref = resolveVolumeRef();
    runBaseten(buildVolumePushArgs({ dir: join(tmpRoot, "qa"), ref }), "Volume push failed");
  } finally {
    await fsRm(tmpRoot, { recursive: true, force: true });
  }
}

async function createSandbox(name: string): Promise<void> {
  requireApiKey();
  await pushQaVolume();
  runBaseten(buildCreateArgs({ name }), "Sandbox create failed");
}

function execSandbox(name: string, command: string[]): void {
  requireApiKey();
  runBaseten(buildExecArgs({ name, command }), "Sandbox exec failed");
}

function deleteSandbox(name: string): void {
  requireApiKey();
  runBaseten(
    ["sandbox", "delete", "--name", name, "--yes"],
    "Sandbox delete failed",
  );
}

function flag(argv: string[], flagName: string): string | null {
  const index = argv.indexOf(flagName);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function requireName(argv: string[], verb: string): string {
  const name = flag(argv, "--name");
  if (!name) throw new Error(`missing value: ${verb} --name`);
  return name;
}

const COMMANDS: Record<string, (argv: string[]) => void> = {
  image: (argv) => {
    const [sub, ...rest] = argv;
    if (sub !== "push") {
      throw new Error("usage: image push [--no-wait]");
    }
    pushImage({ wait: !rest.includes("--no-wait") });
  },
  create: (argv) => {
    createSandbox(requireName(argv, "create"))
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(
          `Create failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  },
  exec: (argv) => {
    const name = requireName(argv, "exec");
    const separator = argv.indexOf("--");
    const command = separator >= 0 ? argv.slice(separator + 1) : [];
    if (command.length === 0) {
      throw new Error("usage: exec --name <sandbox> -- <command>...");
    }
    execSandbox(name, command);
  },
  delete: (argv) => {
    deleteSandbox(requireName(argv, "delete"));
  },
};

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    console.error("usage: bun qa/index.ts <image|create|exec|delete> [args]");
    process.exit(2);
  }
  handler(argv);
}
