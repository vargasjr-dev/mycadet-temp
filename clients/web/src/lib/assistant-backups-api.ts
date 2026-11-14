/**
 * The assistant's backup dials at the bundle's scoped assistant paths —
 * the same `/v1/assistants/{id}` surface every other panel reads. The
 * serving host (the vite dev proxy, the desktop forward, nginx) injects
 * the gateway bearer on the proxied dial; the browser's own session
 * cookie covers the cloud-hosted case. Authentication never rides in
 * hand-built headers here.
 */

import { z } from "zod";

import { toErrorObject } from "@/utils/api-errors";

/** A backup snapshot as the table renders it. */
export interface AssistantBackup {
  snapshot_name: string;
  pvc: string;
  created_at: string;
  ready_to_use: boolean;
  backup_type: string;
}

export type ListBackupsResult =
  | { ok: true; status: number; data: AssistantBackup[] }
  | { ok: false; status: number; error: Record<string, unknown> };

export type CreateBackupResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: Record<string, unknown> };

export type RestoreBackupResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: Record<string, unknown> };

const PlatformBackupsSchema = z.object({
  backups: z.array(
    z.object({
      snapshot_name: z.string(),
      pvc: z.string().default(""),
      created_at: z.string(),
      ready_to_use: z.boolean(),
      backup_type: z.string().default("point_in_time"),
    }),
  ),
});

const scoped = (assistantId: string, tail = "") =>
  `/v1/assistants/${encodeURIComponent(assistantId)}/backups/${tail}`;

/**
 * Dial the scoped path with the browser's own credentials and shape the
 * outcome as `{ ok, status, data | error }` — the contract the legacy
 * sdk-backed callers already handle.
 */
async function dial(
  path: string,
  failureMessage: string,
  init?: RequestInit,
): Promise<
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: Record<string, unknown> }
> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: toErrorObject(error),
    };
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => (body as { detail?: unknown }).detail)
      .catch(() => null);
    return {
      ok: false,
      status: response.status,
      error: toErrorObject(
        typeof detail === "string" ? detail : `${failureMessage} (${response.status})`,
        response,
      ),
    };
  }
  const data: unknown = await response.json().catch(() => null);
  return { ok: true, status: response.status, data };
}

export async function listAssistantBackups(
  assistantId: string,
): Promise<ListBackupsResult> {
  const result = await dial(scoped(assistantId), "Failed to list assistant backups.");
  if (!result.ok) {
    return result;
  }
  const parsed = PlatformBackupsSchema.safeParse(result.data);
  if (!parsed.success) {
    return {
      ok: false,
      status: result.status,
      error: toErrorObject(parsed.error.message, undefined),
    };
  }
  return { ok: true, status: result.status, data: parsed.data.backups };
}

export async function createAssistantBackup(
  assistantId: string,
): Promise<CreateBackupResult> {
  const result = await dial(scoped(assistantId), "Failed to create assistant backup.", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    status: result.status,
    data:
      result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : {},
  };
}

export async function restoreAssistantBackup(
  assistantId: string,
  backup: AssistantBackup,
): Promise<RestoreBackupResult> {
  const result = await dial(
    scoped(assistantId, `${encodeURIComponent(backup.snapshot_name)}/restore/`),
    "Failed to restore assistant backup.",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    status: result.status,
    data:
      result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : {},
  };
}
