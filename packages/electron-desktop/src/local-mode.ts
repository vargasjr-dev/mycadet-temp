import { z } from "zod";

import {
  isActiveAssistant,
  readLockfile,
  stripSensitiveFields,
  getLocalAssistantStatus,
  readLockfileAssistantAvatar,
  runDevicesList,
  runDevicesRevoke,
  runHatch,
  runUpgrade,
  pairingCancel,
  pairingPoll,
  pairingStart,
  unpairAssistant,
  type LockfileWriteResult,
  type UpgradeOptions,
} from "@mycadet/local-mode";
import type {
  LocalListDevicesResult,
  LocalPairingPollResult,
  LocalPairingStartResult,
  LocalReadAssistantAvatarResult,
  LocalRevokeDeviceResult,
} from "@mycadet/ipc-contract";
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
 *
 * The host's facts (its IPC transport, lockfile refresh, session tokens)
 * arrive as plain arguments to {@link installLocalMode}. There is no
 * module-global runtime to configure first: the previous
 * `configureLocalMode`/`requireRuntime` dance was a second initialization
 * ordering every host had to get right before `whenReady`, and a host that
 * missed it crashed at startup with "Local-mode runtime is unavailable". The
 * renderer-facing surface is unchanged — the web and app renderers keep
 * calling `window.cadet.localMode.*` through the preload bridge.
 */

interface HatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

interface UpgradeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface LocalModeDeps {
  /** The host's IPC transport — handlers register on it directly. */
  handle: IpcHandle;
  /** Called after lockfile mutations so watchers refresh in the same tick. */
  refreshLockfile: () => void;
}

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

/** List a local assistant's paired devices. Mirrors `hatch`'s never-reject contract. */
async function listDevices(
  assistantId: string,
): Promise<LocalListDevicesResult> {
  try {
    return await runDevicesList(assistantId);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Revoke one of a local assistant's paired devices. Never rejects either. */
async function revokeDevice(
  assistantId: string,
  hashedDeviceId: string,
): Promise<LocalRevokeDeviceResult> {
  try {
    return await runDevicesRevoke(assistantId, hashedDeviceId);
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
 * Register the local-mode IPC handlers. Call once from `whenReady` with the
 * host's facts. Idempotent so it's safe under main-bundle hot reload in dev.
 */
export const installLocalMode = (deps: LocalModeDeps): void => {
  if (installed) {
    return;
  }
  installed = true;

  const { handle, refreshLockfile } = deps;

  handle("cadet:localMode:hatch", z.tuple([z.string().optional()]), ([remote]) =>
    hatch(remote || undefined),
  );

  handle("cadet:localMode:readLockfile", z.tuple([]), () => {
    const lockfile = readLockfile();
    stripSensitiveFields(lockfile);
    return lockfile;
  });

  handle(
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
  handle(
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

  handle(
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

  handle("cadet:localMode:pairingCancel", oneOptionalStringArgs, ([handle]) => ({
    ok: pairingCancel(handle),
  }));

  handle("cadet:localMode:listDevices", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return listDevices(assistantId);
  });

  handle(
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

  handle("cadet:localMode:upgrade", upgradeArgs, ([assistantId, options]) => {
    if (!assistantId) {
      return { ok: false, error: "Missing assistantId" };
    }
    return upgrade(assistantId, options);
  });

  handle("cadet:localMode:status", assistantIdArgs, ([assistantId]) => {
    if (!assistantId) {
      return { ok: false, status: 400, error: "Missing assistantId" };
    }
    if (upgradingLocalAssistantIds.has(assistantId)) {
      return { ok: true, state: "upgrading" };
    }
    return getLocalAssistantStatus(assistantId);
  });

  handle(
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
