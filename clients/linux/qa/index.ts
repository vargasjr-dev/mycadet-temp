#!/usr/bin/env bun
/**
 * Baseten sandbox manager for desktop QA.
 *
 * One sandbox = one QA run of the Linux desktop client against the real
 * stack: the image (see ./Dockerfile) carries the toolchain — Xvfb, the
 * Electron runtime deps, the published `mycadet` daemon/gateway/web stack,
 * a hatched golden assistant — and each run checks out the git ref under
 * test, builds `clients/linux` inside the sandbox, and drives it headless.
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
 *   bun clients/linux/qa/index.ts create --name qa-pr599 [--env KEY=VALUE]...
 *   bun clients/linux/qa/index.ts run --name qa-pr599 --ref vargas-jr/desktop-single-origin
 *   bun clients/linux/qa/index.ts exec --name qa-pr599 -- <command>...
 *   bun clients/linux/qa/index.ts delete --name qa-pr599
 *
 * The Baseten CLI authenticates from BASETEN_API_KEY in the environment
 * (vaulted as `baseten:api_key` — never committed, never baked into images).
 */
import { spawnSync } from "node:child_process";

/** The Baseten image repository the desktop-QA image is pushed under. */
export const QA_IMAGE_NAME = "cadet-desktop-qa";

/** The sandbox-image tag the create/run commands resolve by default. */
export const QA_IMAGE_REF = `sandbox/${QA_IMAGE_NAME}:latest`;

/** Where the QA run checks out and builds the client under test. */
export const QA_WORKSPACE = "/qa";

/** The env var the Baseten CLI reads its API key from. */
export const BASETEN_API_KEY_ENV = "BASETEN_API_KEY";

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
  /** Image reference. Defaults to {@link QA_IMAGE_REF}. */
  image?: string;
  /** Extra environment — the credential injection path. */
  env?: Record<string, string>;
};

/** Assemble the `baseten sandbox create` argv. Exported for tests. */
export function buildCreateArgs(options: CreateOptions): string[] {
  const args = [
    "sandbox",
    "create",
    "--name",
    options.name,
    "--image",
    options.image ?? QA_IMAGE_REF,
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  return args;
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
  /** The git ref (branch/sha) to check out and build the client from. */
  ref: string;
  /** Repo to fetch. Defaults to the monorepo's GitHub remote. */
  repo?: string;
};

/** Assemble the in-sandbox QA pipeline: fetch, build, drive, report. */
export function buildQaPipelineArgs(options: RunOptions): string[][] {
  const repo =
    options.repo ?? "https://github.com/vargasjr-dev/mycadet-temp.git";
  const checkout = [
    "sh",
    "-c",
    [
      `rm -rf ${QA_WORKSPACE}/*`,
      `git clone --depth 1 --branch ${options.ref} ${repo} ${QA_WORKSPACE}/src`,
    ].join(" && "),
  ];
  const install = [
    "sh",
    "-c",
    `cd ${QA_WORKSPACE}/src && bun install --frozen-lockfile`,
  ];
  const build = [
    "sh",
    "-c",
    `cd ${QA_WORKSPACE}/src/clients/linux && bun install --frozen-lockfile && bun run build`,
  ];
  const drive = [
    "sh",
    "-c",
    `cd ${QA_WORKSPACE}/src/clients/linux && xvfb-run -a bun run qa`,
  ];
  return [checkout, install, build, drive];
}

/** Run the full QA pipeline for `ref` inside sandbox `name`, streaming output. */
export function runQa(options: RunOptions): void {
  const steps = buildQaPipelineArgs(options);
  const names = ["checkout", "install", "build", "drive"];
  for (const [index, command] of steps.entries()) {
    console.log(`[qa] ${names[index]}: ${command[1]}`);
    execBaseten(
      buildExecArgs({ name: options.name, command }),
      `QA step ${names[index]} failed`,
    );
  }
}

/** Push (and by default build) the desktop-QA image, streaming build logs. */
export function pushImage(options: ImagePushOptions = {}): void {
  execBaseten(buildImagePushArgs(options), "Image push failed");
}

/** Create a sandbox from the pushed image. Secrets ride `env`, never layers. */
export function createSandbox(options: CreateOptions): void {
  execBaseten(buildCreateArgs(options), "Sandbox create failed");
}

/** Exec a command inside the named sandbox, streaming output. */
export function execSandbox(options: ExecOptions): void {
  execBaseten(buildExecArgs(options), "Sandbox exec failed");
}

/** Delete the named sandbox (irreversible — its local files go with it). */
export function deleteSandbox(name: string): void {
  execBaseten(
    ["sandbox", "delete", "--name", name, "--yes"],
    "Sandbox delete failed",
  );
}

function execBaseten(args: string[], failure: string): void {
  if (!process.env[BASETEN_API_KEY_ENV]) {
    throw new Error(
      `${BASETEN_API_KEY_ENV} is not set — the Baseten CLI authenticates ` +
        `from it (vaulted as baseten:api_key; never commit it).`,
    );
  }
  const result = spawnSync("baseten", args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error(
        "The Baseten CLI was not found on PATH. Install it first: " +
          "https://docs.baseten.co/reference/cli/baseten/overview.md#install",
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${failure}: baseten ${args.join(" ")} exited with ${result.status}`);
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
    const image = flag(argv, "--image");
    const env = Object.fromEntries(collectEnv(argv));
    createSandbox({ name, image: image ?? undefined, env });
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
    const ref = requireValue(flag(argv, "--ref"), "run --ref");
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

function collectEnv(argv: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--env") {
      const pair = argv[index + 1] ?? "";
      const equals = pair.indexOf("=");
      if (equals > 0) pairs.push([pair.slice(0, equals), pair.slice(equals + 1)]);
    }
  }
  return pairs;
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
