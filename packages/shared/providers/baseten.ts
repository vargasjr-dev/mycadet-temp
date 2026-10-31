import { spawnSync } from "node:child_process";

/**
 * The Baseten sandbox helpers every Baseten consumer shares: the CLI runner
 * (spawn, stream, ENOENT message, exit-code check) and the API-key env
 * contract. Consumers keep their own argv assembly and credential posture —
 * the CLI's sandbox flow authenticates via `baseten auth login` and never
 * requires the env key, while scripted consumers (the desktop-QA manager)
 * check the key themselves.
 */

/** The env var the Baseten CLI reads its API key from. */
export const BASETEN_API_KEY_ENV = "BASETEN_API_KEY";

/** The CLI-not-found message, with Baseten's install doc. */
export const BASETEN_CLI_MISSING =
  "The Baseten CLI was not found on PATH. Install it first: " +
  "https://docs.baseten.co/reference/cli/baseten/overview.md#install";

/**
 * Run the `baseten` CLI with inherited stdio so build/exec logs stream to
 * the caller. Throws on a missing CLI, a spawn failure, or a non-zero exit.
 */
export function runBaseten(args: string[], failure: string): void {
  const result = spawnSync("baseten", args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error(BASETEN_CLI_MISSING);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${failure}: baseten ${args.join(" ")} exited with ${result.status}`,
    );
  }
}
