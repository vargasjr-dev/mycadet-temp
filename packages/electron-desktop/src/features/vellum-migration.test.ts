import { beforeEach, describe, expect, mock, test } from "bun:test";

import { recordedIpcHandlers } from "../../test-setup";

/**
 * The vellum-migration feature is a shim: the engine (mocked here) owns the
 * probe, the run, the consent facts, and the never-again bookkeeping. What
 * this module adds — and what these tests pin — is the app's managed cadet
 * CLI as the engine's ProcessOps, the event stream to the renderer, and the
 * single-flight rules (one probe, one prepare gather, one run).
 */

type RawHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, RawHandler>();
const sent: Array<{ channel: string; payload: unknown }> = [];

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0",
    getName: () => "Cadet",
    getPath: () => "/tmp",
  },
  ipcMain: {
    handle: (channel: string, h: RawHandler) => handlers.set(channel, h),
    on: () => undefined,
  },
  BrowserWindow: class {},
}));

const OFFER = {
  status: "offer",
  vellumRoot: "/home/u/.local/share/vellum",
  cadetRoot: "/home/u/.local/share/cadet",
  assistantHandles: ["vellum-fresh-eel"],
  retiredCount: 0,
  layout: "modern",
};

const CONFIRM_INFO = {
  vellumRoot: OFFER.vellumRoot,
  cadetRoot: OFFER.cadetRoot,
  cadetRootExists: false,
  assistants: [{ name: "vellum-fresh-eel", docker: false }],
  retiredCount: 0,
  rootSizeBytes: 1024,
  dockerVolumeBytes: null,
  dockerVolumeCount: 0,
};

const engineCalls = { probe: 0, detect: 0, gather: 0, migrate: 0, decline: 0 };
let migrateImpl: (
  opts: Record<string, unknown>,
) => Promise<unknown> = async () => ({
  ok: true,
  exitCode: 0,
  mode: "migrate",
  detect: OFFER,
  steps: [],
  backupPath: null,
  startedAt: "",
  finishedAt: "",
  durationMs: 0,
});

mock.module("@mycadet/vellum", () => ({
  probeDesktopInstall: async () => {
    engineCalls.probe += 1;
    return OFFER;
  },
  detectInstall: async () => {
    engineCalls.detect += 1;
    return {
      vellumRoot: OFFER.vellumRoot,
      docker: { instances: [], images: [] },
    };
  },
  gatherConfirmInfo: async () => {
    engineCalls.gather += 1;
    return CONFIRM_INFO;
  },
  migrate: async (opts: Record<string, unknown>) => {
    engineCalls.migrate += 1;
    return migrateImpl(opts);
  },
  markDeclined: async () => {
    engineCalls.decline += 1;
    return true;
  },
  defaultProcessOps: {
    find: async () => [],
    vellumVersion: async () => null,
    vellumSleep: async () => {},
    cadetSleep: async () => {},
    installCadet: async () => {},
    cadetWakeAll: async () => {},
    cadetLogin: async () => {},
    cadetBinAvailable: async () => false,
    cadetVersion: async () => ({ version: null }),
    dockerVolumeToDir: async () => {},
    dockerDirToVolume: async () => {},
    dockerAvailable: async () => false,
    npmGlobalRoot: async () => null,
  },
}));

mock.module("../app-logger", () => ({
  default: {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
  },
}));

mock.module("../main-window", () => ({
  current: () => stubWindow,
}));

const stubWindow = {
  webContents: {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
  },
};

mock.module("../cli-installer", () => ({
  getCliBinPath: () => "/app/cli/cadet",
  isCliInstalled: () => true,
  ensureCliInstalled: async () => undefined,
  buildInstallEnv: () => ({}),
  writeCliLocator: () => undefined,
}));

const { install, resetVellumMigrationState } =
  await import("./vellum-migration");
const { resolveAllowedOrigin } = await import("../app-origin");

const allowedEvent = (): { senderFrame: { origin: string } } => {
  const { protocol, host } = resolveAllowedOrigin();
  return { senderFrame: { origin: `${protocol}//${host}` } };
};

beforeEach(() => {
  resetVellumMigrationState();
  handlers.clear();
  sent.length = 0;
  engineCalls.probe = 0;
  engineCalls.detect = 0;
  engineCalls.gather = 0;
  engineCalls.migrate = 0;
  engineCalls.decline = 0;
  migrateImpl = async () => ({
    ok: true,
    exitCode: 0,
    mode: "migrate",
    detect: OFFER,
    steps: [],
    backupPath: null,
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
  });
});

describe("install (vellum migration)", () => {
  test("registers the four channels and probes at install", async () => {
    install();
    expect([...handlers.keys()].sort()).toEqual(
      [
        "cadet:vellumMigration:decline",
        "cadet:vellumMigration:get",
        "cadet:vellumMigration:prepare",
        "cadet:vellumMigration:start",
      ].sort(),
    );
    // The probe rides boot — it does not wait for the renderer to ask.
    expect(engineCalls.probe).toBe(1);
  });

  test("get returns the shared probe verdict", async () => {
    install();
    const probe = (await handlers.get("cadet:vellumMigration:get")!(
      allowedEvent(),
    )) as unknown;
    expect(probe).toEqual(OFFER);
    expect(engineCalls.probe).toBe(1);
  });

  test("prepare single-flights the confirm-info gather", async () => {
    install();
    const handler = handlers.get("cadet:vellumMigration:prepare")!;
    const [a, b] = [
      handler(allowedEvent()),
      handler(allowedEvent()),
    ] as Promise<unknown>[];
    expect(await a).toEqual(CONFIRM_INFO);
    expect(await b).toEqual(CONFIRM_INFO);
    expect(engineCalls.detect).toBe(1);
    expect(engineCalls.gather).toBe(1);
  });

  test("start runs once; the engine's hooks stream to the renderer", async () => {
    const seen: Record<string, unknown> = {};
    migrateImpl = async (opts) => {
      seen.confirm = await (
        opts.confirm as (info: unknown) => Promise<boolean>
      )({});
      (opts.onStepStart as (step: string) => void)("verify");
      (opts.onStepItem as (step: string, item: unknown) => void)("verify", {
        name: "assistants/vellum-fresh-eel",
        status: "progress",
        progress: { bytes: 512, totalBytes: 1024 },
      });
      (opts.onStepDone as (result: unknown) => void)({
        step: "verify",
        status: "completed",
        summary: "clean",
        issues: [],
      });
      // The engine's cadet ops are the app's managed CLI, not global npm.
      const ops = opts.processOps as Record<string, () => Promise<unknown>>;
      expect(ops.cadetBinAvailable).not.toBeUndefined();
      return {
        ok: true,
        exitCode: 0,
        mode: "migrate",
        detect: OFFER,
        steps: [],
        backupPath: null,
        startedAt: "",
        finishedAt: "",
        durationMs: 0,
      };
    };
    install();
    const handler = handlers.get("cadet:vellumMigration:start")!;
    const [first, second] = [
      handler(allowedEvent()),
      handler(allowedEvent()),
    ] as Promise<unknown>[];
    const finalState = (await Promise.all([first, second]))[0] as {
      state: string;
      exitCode?: number;
    };
    expect(seen.confirm).toBe(true);
    expect(engineCalls.migrate).toBe(1);
    expect(finalState.state).toBe("done");
    expect(finalState.exitCode).toBe(0);
    // The state transitions and the step stream both reached the window.
    const statePayloads = sent
      .filter((s) => s.channel === "cadet:vellumMigration:state")
      .map((s) => (s.payload as { state: string }).state);
    expect(statePayloads).toEqual(["running", "done"]);
    const stepChannels = sent.filter(
      (s) => s.channel === "cadet:vellumMigration:step",
    );
    expect(
      stepChannels.map((s) => (s.payload as { kind: string }).kind),
    ).toEqual(["start", "item", "done"]);
  });

  test("a failed run reports state failed with the error", async () => {
    migrateImpl = async () => ({
      ok: false,
      exitCode: 6,
      mode: "migrate",
      detect: OFFER,
      steps: [],
      backupPath: null,
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
    });
    install();
    const finalState = (await handlers.get("cadet:vellumMigration:start")!(
      allowedEvent(),
    )) as { state: string; exitCode?: number; error?: string };
    expect(finalState.state).toBe("failed");
    expect(finalState.exitCode).toBe(6);
    expect(finalState.error).toContain("6");
  });

  test("decline books the never-again marker only when asked", async () => {
    install();
    await handlers.get("cadet:vellumMigration:decline")!(allowedEvent(), {
      neverAgain: false,
    });
    expect(engineCalls.decline).toBe(0);
    await handlers.get("cadet:vellumMigration:decline")!(allowedEvent(), {
      neverAgain: true,
    });
    expect(engineCalls.decline).toBe(1);
  });

  test("a quiet probe never declines anything", async () => {
    mock.module("@mycadet/vellum", () => ({
      probeDesktopInstall: async () => ({
        status: "quiet",
        reason: "cadet-in-use",
      }),
      detectInstall: async () => ({}),
      gatherConfirmInfo: async () => CONFIRM_INFO,
      migrate: async () => ({}),
      markDeclined: async () => {
        engineCalls.decline += 1;
        return true;
      },
      defaultProcessOps: {},
    }));
    install();
    await handlers.get("cadet:vellumMigration:decline")!(allowedEvent(), {
      neverAgain: true,
    });
    expect(engineCalls.decline).toBe(0);
  });
});
