/**
 * Baseten sandbox manager for Cadet QA — desktop, Android, web.
 *
 * One sandbox-image family (`cadet-qa` — this directory's Dockerfiles) for
 * every client-QA need. One sandbox = one QA run: the image carries the
 * toolchain plus the open-source repo pulled into /qa at build time; the runs
 * build the client under test from the ref they name and drive it headless
 * inside the sandbox.
 *
 * Usage:
 *
 *   bun qa/index.ts image push
 *   bun qa/index.ts create --name qa-pr645
 *   bun qa/index.ts run --name qa-pr645 --target desktop [--ref <git-ref>]
 *   bun qa/index.ts boot --name qa-pr645     # android only: warm the emulator
 *   bun qa/index.ts exec --name qa-desktop-1108 -- <command>...
 *   bun qa/index.ts delete --name qa-pr645
 *
 * The Baseten CLI authenticates from BASETEN_API_KEY (vaulted as
 * baseten:api_key — pass it in the environment, never bake it into the
 * image).
 */

import {
  BASETEN_API_KEY_ENV,
  runBaseten,
} from "@mycadet/shared/providers/baseten";

/** The Baseten image repository the cadet-QA image is pushed under. */
export const QA_IMAGE_NAME = "cadet-qa";

/** The sandbox-image tag the create/run commands resolve by default. */
export const QA_IMAGE_REF = `sandbox/${QA_IMAGE_NAME}:latest`;

/** Where the image pulls the open-source repo (the QA working tree). */
export const QA_WORKSPACE = "/qa";

/** The QA targets one sandbox image covers. */
export const QA_TARGETS = ["desktop", "android", "web"] as const;
export type QaTarget = (typeof QA_TARGETS)[number];

export type ImagePushOptions = {
  /** Target image repository name. Defaults to {@link QA_IMAGE_NAME}. */
  name?: string;
  /** Build-context directory. Defaults to this module's directory. */
  dir?: string;
  /** Block until the Baseten-side build finishes (default true). */
  wait?: boolean;
};

/** Assemble the `baseten sandbox image push` argv. Exported for tests. */
export function buildImagePushArgs(options: ImagePushOptions = {}): string[] {
  const args = [
    "sandbox",
    "image",
    "push",
    "--name",
    options.name ?? QA_IMAGE_NAME,
    "--dir",
    options.dir ?? import.meta.dir,
  ];
  if (options.wait ?? true) args.push("--wait");
  return args;
}

export type CreateOptions = {
  /** Sandbox name — one QA run per name. */
  name: string;
  /** Sandbox memory in MB — also sets the CPU allocation. */
  memory?: number;
  /** Image to create from. Defaults to the pushed QA image. */
  image?: string;
};

/**
 * The account ceiling on sandbox memory (Baseten rejects bigger creates with
 * a 429) — the monorepo's frozen install needs more than RAM alone, so the
 * pipelines also set up swap before installing (see SWAP_SETUP).
 */
export const QA_SANDBOX_MEMORY_MB = 4096;

/** Assemble the `baseten sandbox create` argv. Exported for tests. */
export function buildCreateArgs(options: CreateOptions): string[] {
  // The platform default is baseten/base-image — a bare sandbox with no QA
  // toolchain. The runs assume the cadet-qa image (the /qa workspace, Xvfb,
  // bun), so create pins it explicitly.
  return [
    "sandbox",
    "create",
    "--name",
    options.name,
    "--image",
    options.image ?? QA_IMAGE_REF,
    "--memory",
    String(options.memory ?? QA_SANDBOX_MEMORY_MB),
  ];
}

export type ExecOptions = {
  /** Sandbox name to exec into. */
  name: string;
  /** Command (with args) to run inside the sandbox. */
  command: string[];
};

/** Assemble the `baseten sandbox exec` argv. Exported for tests. */
export function buildExecArgs(options: ExecOptions): string[] {
  return ["sandbox", "exec", "--name", options.name, "--", ...options.command];
}

export type RunOptions = {
  name: string;
  target: QaTarget;
  /** Optional git ref to move the pulled repo to before building — the image
   * clones the default branch at build time, so a run against a PR names the
   * branch here. */
  ref?: string;
};

/** The in-sandbox path of the emulator boot script's two halves. */
export const BOOT_SCRIPT = `${QA_WORKSPACE}/qa/scripts/android/boot-emulator.sh`;

/** The in-sandbox path of the android install/launch/screenshot script. */
export const DRIVE_SCRIPT = `${QA_WORKSPACE}/qa/scripts/android/drive.sh`;

/**
 * Swap, set up before any install: the account ceiling is 4 GB of RAM and
 * the monorepo's frozen install (plus the Electron/Playwright downloads)
 * OOMs a 4 GB sandbox (exit 137). Best effort — a sandbox that refuses
 * swapon runs without it and the installs are on their own.
 */
export const SWAP_SETUP = [
  "fallocate -l 6G /swapfile",
  "chmod 600 /swapfile",
  "mkswap /swapfile >/dev/null 2>&1",
  "swapon /swapfile 2>/dev/null || echo '[qa] swap unavailable — running on RAM alone'",
  "free -m | head -3",
].join(" && ");

/**
 * The scenario pipelines, target by target. Every scenario builds the client
 * under test from the pulled repo (fetching the ref the run names, when it
 * names one — never a fresh clone) and drives it headless:
 *
 * - desktop: build the Electron client, run its per-file test suite under
 *   Xvfb. (An app-driving tier — launch under Xvfb and screenshot — is the
 *   next step; today the desktop tests are the QA that runs.)
 * - android: build the Capacitor bundle, sync the Gradle project, boot the
 *   emulator (start before Gradle, wait after — the TCG boot overlaps the
 *   dependency downloads), then install and drive the APK.
 * - web: run the web package's test suite headless (the image's Chromium
 *   libs cover Playwright's browser tests).
 */
export function buildQaPipelineArgs(options: RunOptions): {
  steps: string[][];
  names: string[];
} {
  const steps: string[][] = [];
  const names: string[] = [];
  steps.push(["sh", "-c", SWAP_SETUP]);
  names.push("swap");
  if (options.ref) {
    steps.push([
      "sh",
      "-c",
      `git -C ${QA_WORKSPACE} fetch origin ${options.ref} && git -C ${QA_WORKSPACE} checkout ${options.ref}`,
    ]);
    names.push("fetch");
  }

  // --ignore-scripts: the account ceiling is 4 GB and electron's binary
  // download is the spike that OOMs the install (exit 137). electron-vite's
  // build and the per-file bun tests don't run the binary — vite bundles
  // renderer/main/preload from source.
  const rootInstall = `cd ${QA_WORKSPACE} && bun install --frozen-lockfile --ignore-scripts`;
  steps.push(["sh", "-c", rootInstall]);
  names.push("install");

  if (options.target === "desktop") {
    steps.push(
      [
        "sh",
        "-c",
        `cd ${QA_WORKSPACE}/clients/linux && bun install --frozen-lockfile --ignore-scripts && bun run build`,
      ],
      [
        "sh",
        "-c",
        `cd ${QA_WORKSPACE}/clients/linux && xvfb-run -a bun scripts/run-tests.ts`,
      ],
    );
    names.push("build", "drive");
  } else if (options.target === "android") {
    steps.push(
      [
        "sh",
        "-c",
        `cd ${QA_WORKSPACE}/clients/android && bun install --frozen-lockfile --ignore-scripts && bun run build`,
      ],
      ["sh", "-c", `sh ${BOOT_SCRIPT} start`],
      [
        "sh",
        "-c",
        `cd ${QA_WORKSPACE}/clients/android && ./gradlew assembleDebug`,
      ],
      ["sh", "-c", `sh ${BOOT_SCRIPT} wait`],
      ["sh", "-c", `sh ${DRIVE_SCRIPT}`],
    );
    names.push("bundle", "emulator-start", "gradle", "emulator-wait", "drive");
  } else {
    steps.push([
      "sh",
      "-c",
      `cd ${QA_WORKSPACE}/clients/web && bun install --frozen-lockfile --ignore-scripts && bun run test`,
    ]);
    names.push("test");
  }

  return { steps, names };
}

/** Run the full QA pipeline for `target` inside sandbox `name`. */
export function runQa(options: RunOptions): void {
  const { steps, names } = buildQaPipelineArgs(options);
  // One sandbox = one QA run: create it here (from the pinned image) so a
  // `run` is self-sufficient. A sandbox that already exists under the name
  // is reused — the platform's create errors on duplicates and the steps
  // below are what matter.
  requireApiKey();
  try {
    createSandbox({ name: options.name });
  } catch (error) {
    console.log(
      `[qa] create failed (reusing the sandbox if it exists): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  for (const [index, command] of steps.entries()) {
    // The steps are `sh -c <script>` pairs — the script is the last element,
    // and printing argv[1] would log the literal "-c".
    console.log(
      `[qa] ${names[index]}: ${command[command.length - 1] ?? command.join(" ")}`,
    );
    requireApiKey();
    runBaseten(
      buildExecArgs({ name: options.name, command }),
      `QA step ${names[index]} failed`,
    );
  }
}

/**
 * Boot the Android emulator and block until it is usable — a warm-up verb,
 * so a sandbox created ahead of a QA session spends the wait before the
 * session starts instead of inside it. The android pipeline calls the boot
 * script's two halves itself; this is only for eager humans and agents.
 */
export function bootSandbox(options: CreateOptions): void {
  for (const mode of ["start", "wait"] as const) {
    console.log(`[qa] emulator ${mode}`);
    requireApiKey();
    runBaseten(
      buildExecArgs({
        name: options.name,
        command: ["sh", "-c", `sh ${BOOT_SCRIPT} ${mode}`],
      }),
      `Emulator ${mode} failed`,
    );
  }
}

export function pushImage(options: ImagePushOptions = {}): void {
  requireApiKey();
  runBaseten(buildImagePushArgs(options), "Image push failed");
}

export function createSandbox(options: CreateOptions): void {
  requireApiKey();
  runBaseten(buildCreateArgs(options), "Sandbox create failed");
}

/** Exec a command inside the named sandbox, streaming output. */
export function execSandbox(options: ExecOptions): void {
  requireApiKey();
  runBaseten(buildExecArgs(options), "Sandbox exec failed");
}

export function deleteSandbox(name: string): void {
  requireApiKey();
  runBaseten(["sandbox", "delete", "--name", name, "--yes"], "Sandbox delete failed");
}

/**
 * The Baseten CLI authenticates from the env key for scripted use — check
 * before the first exec so a run fails fast with the fix, not mid-pipeline.
 */
function requireApiKey(): void {
  if (!process.env[BASETEN_API_KEY_ENV]) {
    throw new Error(
      `${BASETEN_API_KEY_ENV} is not set — the Baseten CLI authenticates ` +
        `from it (vaulted as baseten:api_key; never commit it).`,
    );
  }
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
    const name = requireValue(flag(argv, "--name"), "create --name");
    createSandbox({ name });
  },
  boot: (argv) => {
    const name = requireValue(flag(argv, "--name"), "boot --name");
    bootSandbox({ name });
  },
  exec: (argv) => {
    const name = requireValue(flag(argv, "--name"), "exec --name");
    const separator = argv.indexOf("--");
    const command = separator >= 0 ? argv.slice(separator + 1) : [];
    if (command.length === 0) {
      throw new Error("usage: exec --name <sandbox> -- <command>...");
    }
    execSandbox({ name, command });
  },
  run: (argv) => {
    const name = requireValue(flag(argv, "--name"), "run --name");
    const target = requireValue(flag(argv, "--target"), "run --target");
    if (!QA_TARGETS.includes(target as QaTarget)) {
      throw new Error(
        `unknown target: ${target} (choose from ${QA_TARGETS.join("|")})`,
      );
    }
    const ref = flag(argv, "--ref") ?? undefined;
    runQa({ name, target: target as QaTarget, ref });
  },
  delete: (argv) => {
    const name = requireValue(flag(argv, "--name"), "delete --name");
    deleteSandbox(name);
  },
};

function flag(argv: string[], flagName: string): string | null {
  const index = argv.indexOf(flagName);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function requireValue(value: string | null, usage: string): string {
  if (!value) throw new Error(`missing value: ${usage}`);
  return value;
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    console.error(
      "usage: bun qa/index.ts <image|create|boot|exec|run|delete> [args]",
    );
    process.exit(2);
  }
  handler(argv);
}
