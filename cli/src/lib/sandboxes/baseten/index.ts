import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Baseten sandbox image for Cadet.
 *
 * The sandbox ships the published `mycadet` stack and hatches a golden
 * assistant at build time; the entrypoint wakes the assistant and holds the
 * sandbox open. The model loop runs in the sandbox, so the assistant daemon
 * is the primary workload — sandbox-api (Baseten's control plane) is a
 * window into it, not a proxy in front of it.
 *
 * Image files live beside this module (Dockerfile, entrypoint.sh); push with
 * `baseten sandbox image push --name cadet --dir <dir> --wait`, then create
 * sandboxes with `baseten sandbox create --image sandbox/cadet:latest` and
 * inject secrets with `--env KEY=VALUE`. Credentials never bake into the
 * image.
 */

/** The Baseten image repository Cadet sandboxes are pushed under. */
export const BASETEN_IMAGE_NAME = "cadet";

/** The name of the assistant the image hatches at build time. */
export const BASETEN_ASSISTANT_NAME = "cadet";

/**
 * Directory containing the image's Dockerfile and entrypoint.sh — passed to
 * `baseten sandbox image push --dir`.
 */
export function basetenSandboxDir(): string {
  return import.meta.dir;
}

export type BasetenPushOptions = {
  /** Target image repository name. Defaults to {@link BASETEN_IMAGE_NAME}. */
  name?: string;
  /** Build-context directory. Defaults to {@link basetenSandboxDir}. */
  dir?: string;
  /** Block until the Baseten-side build finishes (default true). */
  wait?: boolean;
};

/** Assemble the `baseten sandbox image push` argv. Exported for tests. */
export function buildPushArgs(options: BasetenPushOptions = {}): string[] {
  const name = options.name ?? BASETEN_IMAGE_NAME;
  const dir = options.dir ?? basetenSandboxDir();
  const args = ["sandbox", "image", "push", "--name", name, "--dir", dir];
  if (options.wait ?? true) args.push("--wait");
  return args;
}

/**
 * Push (and by default build) the Cadet sandbox image to Baseten. Runs the
 * `baseten` CLI with inherited stdio so build logs stream to the caller.
 */
export function pushBasetenSandboxImage(
  options: BasetenPushOptions = {},
): void {
  runBaseten(buildPushArgs(options));
}

export type BasetenCreateOptions = {
  /** Sandbox name. Defaults to the image name. */
  name?: string;
  /** Image reference. Defaults to `sandbox/<BASETEN_IMAGE_NAME>:latest`. */
  image?: string;
  /** Extra environment for the sandbox — the credential injection path. */
  env?: Record<string, string>;
};

/** Assemble the `baseten sandbox create` argv. Exported for tests. */
export function buildCreateArgs(options: BasetenCreateOptions = {}): string[] {
  const args = [
    "sandbox",
    "create",
    "--name",
    options.name ?? BASETEN_IMAGE_NAME,
    "--image",
    options.image ?? `sandbox/${BASETEN_IMAGE_NAME}:latest`,
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

/**
 * Create a sandbox from the pushed image. Secrets pass through `env` and
 * reach Baseten as masked sandbox variables — never image layers.
 */
export function createBasetenSandbox(
  options: BasetenCreateOptions = {},
): void {
  runBaseten(buildCreateArgs(options));
}

function runBaseten(args: string[]): void {
  const result = spawnSync("baseten", args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error(
        "The Baseten CLI was not found on PATH. Install it first: " +
          "https://docs.baseten.co/sandboxes/manage#set-up",
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`baseten ${args.join(" ")} exited with ${result.status}`);
  }
}

/** Convenience export for callers that want the Dockerfile path. */
export function basetenDockerfilePath(): string {
  return join(basetenSandboxDir(), "Dockerfile");
}

/** Convenience export for callers that want the entrypoint path. */
export function basetenEntrypointPath(): string {
  return join(basetenSandboxDir(), "entrypoint.sh");
}
