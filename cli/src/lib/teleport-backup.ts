/** Cloud API safety backups use session auth and wait for a restorable root tar. */

import {
  MANAGED_BACKUP_READY_POLL_INTERVAL_MS,
  MANAGED_BACKUP_READY_TIMEOUT_MS,
  managedBackupIsReady,
  readyManagedBackupCreatedAts,
  type ManagedBackupEntry,
} from "@mycadet/local-mode/teleport-backup-policy";

import type { LockfileAssistant } from "./assistant-config.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import {
  authHeaders,
  getCloudUrl,
  invalidateOrgIdCache,
} from "./cloud-client.js";
import { z } from "zod";

const ManagedBackupEntrySchema = z.object({
  snapshot_name: z.string().optional(),
  created_at: z.string().optional(),
  ready_to_use: z.boolean().optional(),
});

const ManagedBackupsResponseSchema = z.object({
  backups: z.array(ManagedBackupEntrySchema).optional(),
});

const CreatedBackupResponseSchema = z.object({
  snapshot_name: z.string().optional(),
  ready_to_use: z.boolean().optional(),
});

function cloudBackupsUrl(entry: LockfileAssistant): string {
  return `${getCloudUrl()}/v1/assistants/${entry.assistantId}/backups/`;
}

async function errorSuffix(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `(${response.status})${body ? `: ${body}` : ""}`;
}

/**
 * Send a cloud backup request with user-session auth, refreshing the
 * cached organization id once on 401 (the same recovery the runtime identity
 * probe applies).
 */
async function platformBackupRequest(
  entry: LockfileAssistant,
  token: string,
  method: "GET" | "POST",
): Promise<Response> {
  const doRequest = async (): Promise<Response> =>
    loopbackSafeFetch(cloudBackupsUrl(entry), {
      method,
      headers: {
        ...(await authHeaders(token, getCloudUrl())),
        Accept: "application/json",
      },
    });
  let response = await doRequest();
  if (response.status === 401) {
    invalidateOrgIdCache(token, getCloudUrl());
    response = await doRequest();
  }
  return response;
}

async function fetchPlatformBackups(
  entry: LockfileAssistant,
  token: string,
): Promise<ManagedBackupEntry[]> {
  const response = await platformBackupRequest(entry, token, "GET");
  if (!response.ok) {
    throw new Error(
      `Cadet Cloud backup list failed ${await errorSuffix(response)}`,
    );
  }
  const parsed = ManagedBackupsResponseSchema.safeParse(await response.json());
  return parsed.success ? (parsed.data.backups ?? []) : [];
}

/**
 * `created_at` of every restorable root archive of a cloud assistant:
 * `GET /v1/assistants/<id>/backups/`.
 */
export async function listPlatformBackups(
  entry: LockfileAssistant,
  token: string,
): Promise<Array<string | undefined>> {
  return readyManagedBackupCreatedAts(await fetchPlatformBackups(entry, token));
}

export interface CreatePlatformBackupOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Capture a root archive of a cloud assistant and wait until it is
 * restorable: `POST /v1/assistants/<id>/backups/`, then re-list until the
 * returned `snapshot_name` reports `ready_to_use`. Throws if the POST fails
 * or the snapshot is not ready within `timeoutMs`.
 */
export async function createPlatformBackup(
  entry: LockfileAssistant,
  token: string,
  options: CreatePlatformBackupOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MANAGED_BACKUP_READY_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? MANAGED_BACKUP_READY_POLL_INTERVAL_MS;

  const response = await platformBackupRequest(entry, token, "POST");
  if (!response.ok) {
    throw new Error(
      `Cadet Cloud backup create failed ${await errorSuffix(response)}`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const created = CreatedBackupResponseSchema.safeParse(body);
  if (!created.success || !created.data.snapshot_name) {
    throw new Error("Cadet Cloud backup create returned no snapshot name");
  }
  if (created.data.ready_to_use === true) {
    return;
  }
  const snapshotName = created.data.snapshot_name;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const backups = await fetchPlatformBackups(entry, token);
    if (managedBackupIsReady(backups, snapshotName)) {
      return;
    }
  }
  throw new Error(
    `Cadet Cloud backup ${snapshotName} was not ready after ${Math.round(timeoutMs / 1000)}s`,
  );
}
