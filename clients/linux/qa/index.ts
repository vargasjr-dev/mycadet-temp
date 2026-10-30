#!/usr/bin/env bun
/**
 * Baseten sandbox manager for desktop QA.
 *
 * One sandbox = one QA run of the Linux desktop client: the image (see
 * ./Dockerfile) carries the toolchain — Xvfb, the Electron runtime deps,
 * the open-source repo pulled at build time — and each run builds
 * `clients/linux` inside the sandbox and drives it headless. QA is performed
 * through the sandbox itself (the sandbox-api control plane), not through a
 * baked-in cadet stack: nothing hatches, nothing wakes.
 *
 * The same harness runs the client locally in a dev container; the sandbox
 * exists so QA scales beyond this machine and survives the desktop
 * worktree churn. The mac-only tier (keychain, notarized install,
 * auto-update feed, native notifications) cannot run here — those scenarios
 * need a real macOS machine and are deliberately out of scope for this
 * manager.
 *
 * Usage:
 *   bun clients/linux/qa/index.ts image push
 *   bun clients/linux/qa/index.ts create --name qa-pr599
 *   bun clients/linux/qa/index.ts run --name qa-pr599 [--ref <git-ref>]
 *   bun clients/linux/qa/index.ts exec --name qa-pr599 -- <command>...
 *   bun clients/linux/qa/index.ts delete --name qa-pr599
 *
 * The Baseten CLI authenticates from BASETEN_API_KEY in the environment
 * (vaulted as `baseten:api_key` — never committed, never baked into images).
 */
import { spawnSync } from "node:child_process";

import {
  BASETEN_API_KEY_ENV,
  runBaseten,
} from "@mycadet/shared/providers/baseten";

/** The Baseten image repository the desktop-QA image is pushed under. */
export const QA_IMAGE_NAME = "cadet-desktop-qa";

/** The sandbox-image tag the create/run commands resolve by default. */
export const QA_IMAGE_REF = `sandbox/${QA_IMAGE_NAME}:latest`;

/** Where the image pulls the open-source repo (the QA working tree). */
export const QA_WORKSPACE = "/qa";

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
};

/** Assemble the `baseten sandbox create` argv. Exported for tests. */
export function buildCreateArgs(options: CreateOptions): string[] {
  return ["sandbox", "create", "--name", options.name];
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
  /** Sandbox name for the QA run. */
  name: string;
  /**
   * Optional git ref to move the pulled repo to before building — the image
   * clones the default branch, so a PR run names its ref here and the run
   * fetches it in the existing clone (never a fresh one).
   */
  ref?: string;
};

/** Assemble the in-sandbox QA pipeline: build the client, drive it. */
export function buildQaPipelineArgs(options: RunOptions): string[][] {
  const steps: string[][] = [];
  if (options.ref) {
    steps.push([
      "sh",
      "-c",
      `git -C ${QA_WORKSPACE} fetch origin ${options.ref} && git -C ${QA_WORKSPACE} checkout ${options.ref}`,
    ]);
  }
  steps.push(
    ["sh", "-c", `cd ${QA_WORKSPACE} && bun install --frozen-lockfile`],
    [
      "sh",
      "-c",
      `cd ${QA_WORKSPACE}/clients/linux && bun install --frozen-lockfile && bun run build`,
    ],
    ["sh", "-c", `cd ${QA_WORKSPACE}/clients/linux && xvfb-run -a bun run qa`],
  );
  return steps;
}

/** Run the full QA pipeline inside sandbox `name`, streaming output. */
export function runQa(options: RunOptions): void {
  const steps = buildQaPipelineArgs(options);
  const names = [
    ...(options.ref ? ["fetch"] : []),
    "install",
    "build",
    "drive",
  ];
  for (const [index, command] of steps.entries()) {
    console.log(`[qa] ${names[index]}: ${command[1]}`);
    requireApiKey();
    runBaseten(
      buildExecArgs({ name: options.name, command }),
      `QA step ${names[index]} failed`,
    );
  }
}

/** Push (and by default build) the desktop-QA image, streaming build logs. */
export function pushImage(options: ImagePushOptions = {}): void {
  runBaseten(buildImagePushArgs(options), "Image push failed");
}

/** Create a sandbox from the pushed image. */
export function createSandbox(options: CreateOptions): void {
  runBaseten(buildCreateArgs(options), "Sandbox create failed");
}

/** Exec a command inside the named sandbox, streaming output. */
export function execSandbox(options: ExecOptions): void {
  runBaseten(buildExecArgs(options), "Sandbox exec failed");
}

/** Delete the named sandbox (irreversible — its local files go with it). */
export function deleteSandbox(name: string): void {
  runBaseten(
    ["sandbox", "delete", "--name", name, "--yes"],
    "Sandbox delete failed",
  );
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
    const ref = flag(argv, "--ref") ?? undefined;
    runQa({ name, ref });
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
      "usage: bun clients/linux/qa/index.ts <image|create|exec|run|delete> [args]",
    );
    process.exit(2);
  }
  handler(argv);
}
