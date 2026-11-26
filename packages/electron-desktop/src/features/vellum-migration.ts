import { spawn } from "node:child_process";

import {
  defaultProcessOps,
  detectInstall,
  gatherConfirmInfo,
  markDeclined,
  migrate,
  probeDesktopInstall,
  type ConfirmMigrationInfo,
  type DesktopProbe,
  type ProcessOps,
} from "@mycadet/vellum";
import { z } from "zod";

import {
  VELLUM_MIGRATION_DECLINE,
  VELLUM_MIGRATION_GET,
  VELLUM_MIGRATION_PREPARE,
  VELLUM_MIGRATION_START,
  VELLUM_MIGRATION_STATE_EVENT,
  VELLUM_MIGRATION_STEP_EVENT,
} from "@mycadet/ipc-contract";
import type {
  VellumMigrationProbe,
  VellumMigrationRunState,
} from "@mycadet/ipc-contract";

import {
  buildInstallEnv,
  ensureCliInstalled,
  getCliBinPath,
  isCliInstalled,
} from "../cli-installer";
import { current as currentMainWindow } from "../main-window";
import { handle } from "../ipc";
import log from "../app-logger";

/**
 * The vellum → cadet desktop migration, main-process side.
 *
 * A shim by design: the probe verdict, the run, the consent facts, and the
 * never-again bookkeeping all live in the engine package (@mycadet/vellum —
 * `probeDesktopInstall`, `migrate`, `gatherConfirmInfo`, `markDeclined`).
 * This module owns exactly two things the engine cannot: the app's own
 * cadet CLI (the app manages its install — the engine's global-npm ops are
 * replaced with the managed binary) and the event stream to the renderer.
 *
 * The run survives a window close — main-process code keeps going, and a
 * reopened window reattaches via the replayed state event.
 */

/** The app's cadet CLI as the engine's ProcessOps cadet surface. */
const managedCliOps = (): ProcessOps => {
  const runCli = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(getCliBinPath(), args, {
        env: { ...process.env, ...buildInstallEnv() },
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`cadet ${args.join(" ")} exited ${code ?? "unknown"}`),
          );
      });
    });

  return {
    ...defaultProcessOps,
    // The app manages the cadet CLI itself — the engine's global npm/bun
    // install never runs. ensureCliInstalled is idempotent; a machine
    // already hatching through the app has the binary.
    installCadet: async () => {
      await ensureCliInstalled();
    },
    cadetBinAvailable: async () => isCliInstalled(),
    cadetWakeAll: () => runCli(["wake", "--all"]),
    cadetSleep: () => runCli(["sleep", "--all"]),
    // The CLI's browser PKCE flow — the desktop machine has a browser, and
    // the engine only asks when legacy platform credentials were detected.
    cadetLogin: () => runCli(["login"]),
  };
};

/** The probe's verdict — started once at install, shared by every caller. */
let probePromise: Promise<DesktopProbe> | null = null;

const getProbe = (): Promise<DesktopProbe> => {
  probePromise ??= probeDesktopInstall().catch((err: unknown) => {
    log.error("[vellumMigration] probe failed:", err);
    // A failed probe reads as "nothing to offer" — the safe default.
    const quiet: DesktopProbe = { status: "quiet", reason: "no-vellum-root" };
    return quiet;
  });
  return probePromise;
};

// The offer's this-launch suppression. The engine's vellum-side markers
// (migrated, declined-never-again) silence future launches on their own;
// "not now" and a failed run silence this one — the shell's next probe
// reads quiet until the app starts again.
let offerDismissedForLaunch = false;

let runState: VellumMigrationRunState = { state: "idle" };
let confirmCache: ConfirmMigrationInfo | null = null;
let confirmPromise: Promise<ConfirmMigrationInfo | null> | null = null;

const send = (channel: string, payload: unknown): void => {
  currentMainWindow()?.webContents.send(channel, payload);
};

const setRunState = (next: VellumMigrationRunState): void => {
  runState = next;
  if (next.state === "failed") {
    // A failed run quiets the offer for this launch — the run screen's
    // only way out is back, and back should not walk into a fresh offer.
    offerDismissedForLaunch = true;
  }
  send(VELLUM_MIGRATION_STATE_EVENT, next);
};

export const install = (): void => {
  // Kick the probe immediately — it rides the rest of boot; the renderer's
  // hosting screen reads the verdict whenever it mounts.
  void getProbe();

  handle(VELLUM_MIGRATION_GET, z.tuple([]), async () => {
    if (offerDismissedForLaunch) {
      return {
        status: "quiet",
        reason: "declined",
      } satisfies VellumMigrationProbe;
    }
    const probe: VellumMigrationProbe = await getProbe();
    return probe;
  });

  handle(VELLUM_MIGRATION_PREPARE, z.tuple([]), async () => {
    // Single-flight: the consent facts come from a full detect (a tree
    // size walk) — concurrent requests share one gather.
    confirmPromise ??= getProbe().then(async (probe) => {
      if (probe.status !== "offer") return null;
      return gatherConfirmInfo(
        await detectInstall({ vellumRoot: probe.vellumRoot }, managedCliOps()),
        managedCliOps(),
      );
    });
    try {
      const info = await confirmPromise;
      confirmCache = info;
      return info;
    } catch (err) {
      log.error("[vellumMigration] prepare failed:", err);
      return null;
    }
  });

  handle(VELLUM_MIGRATION_START, z.tuple([]), async () => {
    if (runState.state === "running" || runState.state === "preparing") {
      return runState;
    }
    // Consent was given by clicking Begin on the screen this invoke came
    // from — the engine's own confirm callback approves it. The run never
    // starts without that screen having been shown: nothing else calls
    // this channel.
    setRunState({ state: "running" });
    try {
      const probe = await getProbe();
      const report = await migrate({
        // The root the user consented to — the probe's, every time.
        vellumRoot: probe.status === "offer" ? probe.vellumRoot : undefined,
        confirm: async () => true,
        onStepStart: (step) =>
          send(VELLUM_MIGRATION_STEP_EVENT, { kind: "start", step }),
        onStepDone: (result) =>
          send(VELLUM_MIGRATION_STEP_EVENT, {
            kind: "done",
            step: result.step,
            status: result.status,
            summary: result.summary,
            issues: result.issues ?? [],
          }),
        onStepItem: (step, item) =>
          send(VELLUM_MIGRATION_STEP_EVENT, { kind: "item", step, item }),
        processOps: managedCliOps(),
      });
      setRunState({
        state: report.ok ? "done" : "failed",
        exitCode: report.exitCode,
        ...(report.ok ? {} : { error: `migration exited ${report.exitCode}` }),
      });
      return runState;
    } catch (err) {
      log.error("[vellumMigration] run failed:", err);
      setRunState({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return runState;
    }
  });

  handle(
    VELLUM_MIGRATION_DECLINE,
    z.tuple([z.object({ neverAgain: z.boolean() })]),
    async ([{ neverAgain }]) => {
      // Any decline quiets the offer for this launch — "not now" included
      // — so the shell's next probe doesn't walk the user straight back.
      offerDismissedForLaunch = true;
      const probe = await getProbe();
      if (probe.status !== "offer" || !neverAgain) return;
      // Book the never-again marker on the vellum side (best-effort — a
      // failed write means the prompt returns, the safe default).
      await markDeclined(probe.vellumRoot).catch(() => false);
    },
  );
};

/** Test seam: reset the module's single-flight state between tests. */
export const resetVellumMigrationState = (): void => {
  probePromise = null;
  confirmPromise = null;
  confirmCache = null;
  runState = { state: "idle" };
};

/** Test/feature seam: the last confirmed consent facts (null before prepare). */
export const lastConfirmInfo = (): ConfirmMigrationInfo | null => confirmCache;
