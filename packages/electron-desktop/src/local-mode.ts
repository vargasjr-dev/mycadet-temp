import { z } from "zod";

import {
  getGuardianAccessToken,
  isActiveAssistant,
  readLockfile,
  stripSensitiveFields,
  getLocalAssistantStatus,
  readLockfileAssistantAvatar,
  runDevicesList,
  runDevicesRevoke,
  runHatch,
  runRetire,
  runSleep,
  runUpgrade,
  runWake,
  pairingCancel,
  pairingPoll,
  pairingStart,
  unpairAssistant,
  LockfileAssistantSchema,
  configureCliPaths,
  type CliPaths,
  type LockfileWriteResult,
  type TokenResult,
  type UpgradeOptions,
  type WakeOptions,
} from "@mycadet/local-mode";
import type {
  LocalListDevicesResult,
  LocalPairingPollResult,
  LocalPairingStartResult,
  LocalReadAssistantAvatarResult,
  LocalRevokeDeviceResult,
} from "@mycadet/ipc-contract";
import { capabilityToken } from "./capability-registry";
import type { IpcHandle } from "./ipc";

/**
 * Local-mode host bridge: provisions and retires local assistants and reads
 * and writes the lockfile, exposed to the renderer as `window.cadet.localMode.*`.
 *
 * Lifecycle ops delegate to `@mycadet/local-mode`, the shared host library
 * that also backs the web app's dev-server middleware
 * (`clients/web/vite-plugin-local-mode.ts`). The CLI is driven as a subprocess
 * rather than imported in-process so the CLI's own dependency tree never
 * enters this package's typecheck or bundle; the shared library owns the
 * spawn/parse and lockfile-on-disk logic so each host wires transport once.
 *
 * The CLI owns all daemon + gateway process lifecycle: a hatched local
 * assistant runs its own daemon, and this host only ever invokes the CLI as a
 * subprocess. The Electron app does not supervise any daemon of its own.
 */

interface HatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

interface RetireResult {
  ok: boolean;
  error?: string;
}

interface WakeResult {
  ok: boolean;
  error?: string;
}

interface UpgradeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface LocalModeSessionProvider {
  getToken: () => string | null;
}

export const LOCAL_MODE_SESSION = capabilityToken<LocalModeSessionProvider>(
  "desktop.local-mode-session",
);
export interface LocalModeRuntime {
  /** The host's CLI facts — the inlined invocation resolution probes these. */
  cliPaths?: CliPaths;
  handle: IpcHandle;
  refreshLockfile: () => void;
  session: LocalModeSessionProvider;
  unavailableError?: string;
}

let runtime: LocalModeRuntime | null = null;

export const configureLocalMode = (next: LocalModeRuntime): void => {
  runtime = next;
  configureCliPaths(next.cliPaths);
};

export const configureUnavailableLocalMode = (
  handle: IpcHandle,
  unavailableError: string,
): void => {
  configureLocalMode({
    handle,
    refreshLockfile: () => undefined,
    session: { getToken: () => null },
    unavailableError,
  });
};

export const requireRuntime = (): LocalModeRuntime => {
  if (!runtime) {
    throw new Error("Local-mode runtime is unavailable");
  }
  return runtime;
};

/**
 * Provision a local assistant. Never rejects — failures resolve with
 * `{ ok: false, error }` so the renderer renders the same error UI it shows
 * for the web/dev middleware path.
 */
async function hatch(remote?: string): Promise<HatchResult> {
  try {
    const result = await runHatch({ remote });
    return result.ok
      ? { ok: true, assistantId: result.assistantId }
      : { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface SleepResult {
  ok: boolean;
  error?: string;
}

/** Retire a local assistant. Mirrors `hatch`'s never-reject contract. */
async function retire(assistantId: string): Promise<RetireResult> {
  try {
    const result = await runRetire(assistantId, {
      cloudToken: requireRuntime().session.getToken() ?? undefined,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Stop a local assistant's daemon and gateway. Mirrors `hatch`'s never-reject contract. */
async function sleep(assistantId: string): Promise<SleepResult> {
  try {
    const result = await runSleep(assistantId);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** List a local assistant's paired devices. Mirrors `hatch`'s never-reject contract. */
async function listDevices(
  assistantId: string,
): Promise<LocalListDevicesResult> {
  return runDevicesList(assistantId);
}

/** Revoke one paired device's tokens. Mirrors `hatch`'s never-reject contract. */
async function revokeDevice(
  assistantId: string,
  hashedDeviceId: string,
): Promise<LocalRevokeDeviceResult> {
  try {
    return runDevicesRevoke(assistantId, hashedDeviceId);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Wake (start) a local assistant's daemon and gateway, re-seeding its
 * guardian token. The non-destructive repair primitive. Mirrors `hatch`'s
 * never-reject contract.
 */
async function wake(
  assistantId: string,
  options?: WakeOptions,
): Promise<WakeResult> {
  try {
    const result = await runWake(assistantId, options);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const upgradingLocalAssistantIds = new Set<string>();

async function upgrade(
  assistantId: string,
  options?: UpgradeOptions,
): Promise<UpgradeResult> {
  if (!isActiveAssistant(assistantId)) {
    return { ok: false, error: "Can only upgrade the active local assistant" };
  }

  if (upgradingLocalAssistantIds.has(assistantId)) {
    return {
      ok: false,
      error: "An upgrade is already in progress for this assistant.",
    };
  }

  upgradingLocalAssistantIds.add(assistantId);

  try {
    const result = await runUpgrade(assistantId, options);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return result.version
      ? { ok: true, version: result.version }
      : { ok: true };
  } finally {
    upgradingLocalAssistantIds.delete(assistantId);
  }
}

/** Read a guardian token for the trusted main-process bearer mint. */
export async function getLocalGuardianAccessToken(
  assistantId: string,
): Promise<TokenResult> {
  return getGuardianAccessToken(assistantId);
}

// A persisted assistant entry as it crosses the IPC boundary. The
// package's lockfile parser owns the real field-level contract; here we
// only assert the renderer sent an object, so unknown/forward-compat
// fields pass through untouched.
const assistantRecord = z.record(z.string(), z.unknown());

// `retire` and `unpair` each take a single assistant id and keep a
// never-reject contract: a missing id resolves with a structured error the
// renderer renders, rather than rejecting the invoke. The id is therefore
// optional on the wire and validated in the body.
const assistantIdArgs = z.tuple([z.string().optional()]);

// `pairingStart` (a pasted address) and `pairingCancel` (a session handle)
// each take one untrusted string the package validates, optional on the wire
// for the same never-reject reason.
const oneOptionalStringArgs = z.tuple([z.string().optional()]);

// `pairingPoll` (session handle + optional local name) and `revokeDevice`
// (assistant id + hashed device id) each take two strings, optional on the
// wire and validated in the body (never-reject contract).
const twoOptionalStringArgs = z.tuple([
  z.string().optional(),
  z.string().optional(),
]);

// `wake` additionally takes an options object so a user-confirmed repair can
// pass `repairGuardian` through to the CLI's `--repair-guardian` flag. Both
// members stay optional so older renderers' single-argument invokes parse.
const wakeArgs = z.tuple([
  z.string().optional(),
  z.object({ repairGuardian: z.boolean().optional() }).optional(),
]);

const upgradeArgs = z.tuple([
  z.string().optional(),
  z
    .object({
      version: z.string().optional(),
      latest: z.boolean().optional(),
      force: z.boolean().optional(),
    })
    .optional(),
]);

let installed = false;

/**
 * Register the local-mode IPC handlers. Call once from `whenReady`.
 * Idempotent so it's safe under main-bundle hot reload in dev.
 */
export const installLocalMode = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  const configured = requireRuntime();
  const { handle } = configured;
  const unavailableError = configured.unavailableError;
  const ipc: IpcHandle = (channel, schema, fn) => {
    handle(channel, schema, (args, event) => {
      if (!unavailableError) {
        return fn(args, event);
      }
      if (channel === "cadet:localMode:readLockfile") {
        throw new Error(unavailableError);
      }
      const hasStatus = channel.endsWith("Token") || channel.endsWith("status");
      return hasStatus
        ? { ok: false, status: 501, error: unavailableError }
        : { ok: false, error: unavailableError };
    });
  };

  const { refreshLockfile } = configured;

  ipc("cadet:localMode:hatch", z.tuple([z.string().optional()]), ([remote]) =>
    hatch(remote || undefined),
  );

  ipc("cadet:localMode:readLockfile", z.tuple([]), () => {
    const lockfile = readLockfile();
    stripSensitiveFields(lockfile);
    return lockfile;
  });

  ipc("cadet:localMode:retire", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return retire(assistantId);
  });

  ipc(
    "cadet:localMode:unpair",
    assistantIdArgs,
    ([assistantId]): LockfileWriteResult => {
      if (!assistantId) {
        return { ok: false, error: "Missing assistantId" };
      }
      const result = unpairAssistant(assistantId);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      // The paired-gateway forward resolves its allowlist from the watcher's
      // snapshot; refresh it now so the unpaired entry is rejected in the
      // same tick instead of after the next poll.
      refreshLockfile();
      return { ok: true, lockfile: result.lockfile };
    },
  );

  // Pairing runs host-side across three channels: the pasted address goes out
  // on `pairingStart`, the renderer polls the returned handle, and the device
  // code plus the credentials it buys never cross the boundary.
  ipc(
    "cadet:localMode:pairingStart",
    oneOptionalStringArgs,
    async ([address]): Promise<LocalPairingStartResult> => {
      const result = await pairingStart(address);
      if (!result.ok) {
        // `rejection` rides along so the renderer can show its own localized
        // copy for a refused address instead of this host's English.
        return {
          ok: false,
          reason: result.reason,
          error: result.error,
          rejection: result.rejection,
        };
      }
      return {
        ok: true,
        handle: result.handle,
        userCode: result.userCode,
        expiresAt: result.expiresAt,
        intervalSeconds: result.intervalSeconds,
      };
    },
  );

  ipc(
    "cadet:localMode:pairingPoll",
    twoOptionalStringArgs,
    async ([handle, name]): Promise<LocalPairingPollResult> => {
      const result = await pairingPoll({
        handle,
        name,
      });
      if (!result.ok) {
        return { ok: false, reason: result.reason, error: result.error };
      }
      if (result.status === "pending") {
        return {
          ok: true,
          status: "pending",
          expiresAt: result.expiresAt,
          intervalSeconds: result.intervalSeconds,
        };
      }
      // Pairing never defines or saves a lockfile entry — imports create
      // entries; pairs pair with a defined one. The exchange's identity facts
      // go back to the renderer; creating the entry is the import's burden.
      return {
        ok: true,
        status: "imported",
        assistantId: result.assistantId,
        accessOnly: result.accessOnly,
      };
    },
  );

  ipc("cadet:localMode:pairingCancel", oneOptionalStringArgs, ([handle]) => ({
    ok: pairingCancel(handle),
  }));

  ipc("cadet:localMode:sleep", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return sleep(assistantId);
  });

  ipc("cadet:localMode:listDevices", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return listDevices(assistantId);
  });

  ipc(
    "cadet:localMode:revokeDevice",
    twoOptionalStringArgs,
    ([assistantId, hashedDeviceId]) => {
      if (!assistantId) {
        return { ok: false, error: "Missing assistantId" };
      }
      if (!hashedDeviceId) {
        return { ok: false, error: "Missing hashedDeviceId" };
      }
      return revokeDevice(assistantId, hashedDeviceId);
    },
  );

  ipc("cadet:localMode:wake", wakeArgs, ([assistantId, options]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return wake(assistantId, options);
  });

  ipc("cadet:localMode:upgrade", upgradeArgs, ([assistantId, options]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return upgrade(assistantId, options);
  });

  ipc("cadet:localMode:status", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, status: 400, error: "Missing assistantId" };
    }
    if (upgradingLocalAssistantIds.has(assistantId)) {
      return { ok: true, state: "upgrading" };
    }
    return getLocalAssistantStatus(assistantId);
  });

  ipc(
    "cadet:localMode:readAssistantAvatar",
    assistantIdArgs,
    ([assistantId]): LocalReadAssistantAvatarResult => {
      if (!assistantId) {
        return { ok: false, error: "Missing assistantId" };
      }
      return readLockfileAssistantAvatar(assistantId);
    },
  );
};
