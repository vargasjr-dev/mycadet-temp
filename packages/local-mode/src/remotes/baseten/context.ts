import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip";

/**
 * Builds the Baseten image push context from the Dockerfile and entrypoint.sh
 * that live beside this module.
 *
 * The build directory the user sees never contains a version to bump: the
 * launcher stamps `ARG MYCADET_VERSION` from the caller's release version
 * and the optional assistant name into the staged copy before upload.
 */

/** The Baseten image repository Cadet sandboxes are pushed under. */
export const BASETEN_IMAGE_NAME = "cadet";

function escapeShellQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Stamp the ARG lines in a Dockerfile copy. Exported for tests.
 *
 * - `ARG MYCADET_VERSION` (no default) gains the version — a staged context
 *   without it would fail the build, which keeps the failure loud.
 * - `ARG ASSISTANT_NAME` keeps its empty default when no name is given, so
 *   the in-image hatch picks a random assistant name.
 */
export function stampBasetenDockerfile(
  dockerfile: string,
  options: { version: string; assistantName?: string },
): string {
  const version = options.version.replace(/^v/, "");
  if (!version) {
    throw new Error(
      "Refusing to stamp the Baseten image with an empty version.",
    );
  }
  const lines = dockerfile.split("\n").map((line) => {
    if (line.trim() === "ARG MYCADET_VERSION") {
      return `ARG MYCADET_VERSION="${version}"`;
    }
    if (line.trim().startsWith("ARG ASSISTANT_NAME=")) {
      return `ARG ASSISTANT_NAME="${escapeShellQuoted(options.assistantName ?? "")}"`;
    }
    return line;
  });
  const stamped = lines.join("\n");
  if (!stamped.includes(`ARG MYCADET_VERSION="${version}"`)) {
    throw new Error(
      "The Baseten image Dockerfile no longer declares `ARG MYCADET_VERSION` on its own line.",
    );
  }
  return stamped;
}

export type StagedBuildContext = {
  dir: string;
  /** Zip the staged context for the Baseten upload URL. */
  zip: () => Buffer;
  cleanup: () => void;
};

/**
 * Copy the image files into a fresh temp directory with the ARGs stamped.
 * The caller owns cleanup().
 */
export function stageBasetenBuildContext(options: {
  version: string;
  assistantName?: string;
}): StagedBuildContext {
  const dir = mkdtempSync(join(tmpdir(), "cadet-baseten-image-"));
  const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile"), "utf-8");
  const entrypoint = readFileSync(
    join(import.meta.dir, "entrypoint.sh"),
    "utf-8",
  );
  writeFileSync(
    join(dir, "Dockerfile"),
    stampBasetenDockerfile(dockerfile, {
      version: options.version,
      assistantName: options.assistantName,
    }),
  );
  writeFileSync(join(dir, "entrypoint.sh"), entrypoint);
  return {
    dir,
    zip: () => zipBuildContext(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function zipBuildContext(dir: string): Buffer {
  return buildZip(
    ["Dockerfile", "entrypoint.sh"].map((name) => ({
      name,
      data: readFileSync(join(dir, name)),
    })),
  );
}
