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
 * The Baseten CLI authenticates from BASETEN_API_KEY (vaulted as
 * baseten:api_key — pass it in the environment, never bake it into the
 * image).
 */

import {
  BASETEN_API_KEY_ENV,
  runBaseten,
} from "@mycadet/shared/providers/baseten";

const QA_IMAGE_NAME = "cadet-qa";
const QA_IMAGE_REF = `sandbox/${QA_IMAGE_NAME}:latest`;

/** The account ceiling on sandbox memory — Baseten rejects bigger creates with a 429. */
const QA_SANDBOX_MEMORY_MB = 4096;

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
  return [
    "sandbox",
    "create",
    "--name",
    options.name,
    "--image",
    QA_IMAGE_REF,
    "--memory",
    String(QA_SANDBOX_MEMORY_MB),
  ];
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

function createSandbox(name: string): void {
  requireApiKey();
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
    createSandbox(requireName(argv, "create"));
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
