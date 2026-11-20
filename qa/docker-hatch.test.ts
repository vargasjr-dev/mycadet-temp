/**
 * The docker hatch integration suite.
 *
 * Bootstraps a real hatch from three supplied image refs (see
 * `docker-hatch.ts`) and exercises what unit tests cannot: the container
 * start path. A volume mode or socket permission bug never exists at image
 * build time — it only exists when a fresh volume meets a non-root process
 * at container start, which only a booted hatch can observe.
 *
 * The suite runs only when the QA image env is supplied (the release
 * pipeline passes digest refs of the freshly pushed images; PR QA passes
 * locally built tags and fails the job when they are missing). A local
 * `bun test .` without the env skips.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { getCesSocketPath } from "@mycadet/ces-client/socket-path";

import {
  resolveQaImageRefs,
  startQaHatch,
  stopQaHatch,
  type QaHatch,
} from "./docker-hatch";

const imageRefsSupplied = resolveQaImageRefs() !== null;

describe.skipIf(!imageRefsSupplied)(
  "docker hatch (the three service images, fresh volumes)",
  () => {
    let hatch: QaHatch | undefined;

    beforeAll(async () => {
      hatch = await startQaHatch((message) =>
        console.log(`[hatch] ${message}`),
      );
    }, 5 * 60_000);

    afterAll(() => {
      if (hatch) stopQaHatch(hatch);
    });

    test("assistant credentials list serves over the CES socket", () => {
      expect(hatch).toBeDefined();

      // The socket the assistant dials, resolved by the shared ces-client
      // resolver (never a string literal), must exist inside the
      // container. When it is missing, this fails with the path in the
      // message — the fresh-volume/socket-mode failure class.
      process.env.CES_SOCKET_DIR = "/run/ces-ipc";
      const socketPath = getCesSocketPath();
      const probe = spawnSync(
        "docker",
        ["exec", hatch!.containers.assistant, "test", "-S", socketPath],
        { encoding: "utf8" },
      );
      if (probe.status !== 0) {
        throw new Error(
          `CES socket missing at ${socketPath} inside the assistant ` +
            `container — the CES sidecar could not create it on the ` +
            `fresh socket volume\n${(probe.stderr || probe.stdout).trim()}`,
        );
      }

      // The one-shot CLI opens its own CES session over that socket: a
      // successful empty-list response is the end-to-end proof.
      const r = spawnSync(
        "docker",
        [
          "exec",
          hatch!.containers.assistant,
          "assistant",
          "credentials",
          "list",
          "--json",
        ],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      if (r.status !== 0) {
        throw new Error(
          `assistant credentials list failed (exit ${r.status})\n${(r.stderr || r.stdout).trim()}`,
        );
      }

      let parsed: { ok: boolean; credentials: unknown[] };
      try {
        parsed = JSON.parse(r.stdout) as {
          ok: boolean;
          credentials: unknown[];
        };
      } catch {
        const out = r.stdout;
        throw new Error(
          `assistant credentials list --json did not print valid JSON ` +
            `(stdout ${out.length} bytes, stderr ${r.stderr.length} bytes)\n` +
            `stdout head: ${JSON.stringify(out.slice(0, 500))}\n` +
            `stdout tail: ${JSON.stringify(out.slice(-500))}\n` +
            `stderr tail: ${JSON.stringify(r.stderr.slice(-500))}`,
        );
      }
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.credentials)).toBe(true);
    }, 120_000);
  },
);
