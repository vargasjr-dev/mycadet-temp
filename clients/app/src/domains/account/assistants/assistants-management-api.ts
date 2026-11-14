/**
 * The assistants-management account surface's operator dials: backups,
 * upgrades, and the teleport-style signed-url export, at the serving
 * host's scoped assistant paths — the same spelling the operator api
 * serves and proxies verbatim to the cloud on the operator's own
 * credentials. Authentication never rides in hand-built headers here:
 * the host injects the gateway bearer on the proxied dial and the
 * browser's session cookie covers the cloud-hosted case.
 *
 * Responses are validated with the surface's own schemas at this
 * boundary — the operator api has no generated spec to type them (the
 * doctor panel is the precedent).
 */

import { z } from "zod";

import { toErrorObject } from "@app/utils/api-errors";

/** A backup snapshot as the table renders it. */
export interface AssistantBackup {
  snapshot_name: string;
  pvc: string;
  created_at: string;
  ready_to_use: boolean;
  backup_type: string;
}

export type ManagementResult<T> =
  | { ok: true; status: number; data: T }
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

/** A release as the platform's `/v1/releases/` row offers it. */
export interface ReleaseListItem {
  version: string;
  released_at: string;
  is_stable?: boolean;
}

export interface UpgradeDetail {
  detail?: string;
  version?: string;
}

/** The assistant's own record, read for its release version. */
const AssistantRuntimeSchema = z.object({
  current_release_version: z.string().nullable(),
});

const SignedUrlSchema = z.object({ url: z.string().url() });

const scoped = (assistantId: string, tail = "") =>
  `/v1/assistants/${encodeURIComponent(assistantId)}${tail}`;

/**
 * Dial the scoped path with the browser's own credentials and shape the
 * outcome as `{ ok, status, data | error }` — the contract the backups
 * table already handles.
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
        typeof detail === "string"
          ? detail
          : `${failureMessage} (${response.status})`,
        response,
      ),
    };
  }
  const data: unknown = await response.json().catch(() => null);
  return { ok: true, status: response.status, data };
}

export async function listAssistantBackups(
  assistantId: string,
): Promise<ManagementResult<AssistantBackup[]>> {
  const result = await dial(
    scoped(assistantId, "/backups/"),
    "Failed to list assistant backups.",
  );
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
): Promise<ManagementResult<Record<string, unknown>>> {
  const result = await dial(
    scoped(assistantId, "/backups/"),
    "Failed to create assistant backup.",
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

export async function restoreAssistantBackup(
  assistantId: string,
  backup: AssistantBackup,
): Promise<ManagementResult<Record<string, unknown>>> {
  const result = await dial(
    scoped(
      assistantId,
      `/backups/${encodeURIComponent(backup.snapshot_name)}/restore/`,
    ),
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

export async function fetchRuntimeVersion(
  assistantId: string,
): Promise<string | null> {
  const response = await fetch(scoped(assistantId, "/"));
  if (!response.ok) {
    throw new Error(`The assistant read failed (${response.status})`);
  }
  return AssistantRuntimeSchema.parse(await response.json())
    .current_release_version;
}

export async function fetchReleases(): Promise<ReleaseListItem[]> {
  const response = await fetch("/v1/releases/");
  if (!response.ok) {
    throw new Error(`The releases read failed (${response.status})`);
  }
  return (await response.json()) as ReleaseListItem[];
}

export async function createUpgrade(
  assistantId: string,
  body: { version?: string },
): Promise<UpgradeDetail> {
  const response = await fetch(scoped(assistantId, "/upgrade/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`The upgrade dial failed (${response.status})`);
  }
  return (await response.json()) as UpgradeDetail;
}

/**
 * The teleport signed-url dial rides the operator api's host-served row
 * (`POST /v1/assistants/{id}/migrations/signed-url/`): the hop to the
 * cloud happens on the operator's own credentials, so the browser never
 * needs a cloud session to export a backup.
 */
export async function requestSignedDownloadUrl(
  assistantId: string,
  bundleKey: string,
  _runtimeVersion: string | undefined,
  downloadFilename?: string,
): Promise<string> {
  const response = await fetch(
    scoped(assistantId, "/migrations/signed-url/"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "download",
        bundle_key: bundleKey,
        download_filename: downloadFilename,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => (body as { detail?: unknown }).detail)
      .catch(() => null);
    throw new Error(
      typeof detail === "string"
        ? detail
        : `The signed-url dial failed (${response.status})`,
    );
  }
  return SignedUrlSchema.parse(await response.json()).url;
}

export function exportBundleFilename(label: string, date: Date): string {
  const safeLabel = label
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return `${safeLabel || "assistant"}-${date.toISOString().slice(0, 10)}.tar.gz`;
}

// ---------------------------------------------------------------------------
// Semver — the upgrades panel's "is there an upgrade?" comparison. The
// operator api has no generated spec, so the parser lives at this boundary
// instead of a shared util.
// ---------------------------------------------------------------------------

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseSemver(v: string): ParsedSemver | null {
  const stripped = v.replace(/^[vV]/, "");
  const [core, ...rest] = stripped.split("-");
  const pre = rest.length > 0 ? rest.join("-") : null;
  const match = (core ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
  };
}

export function comparePreRelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i];
    const bi = pb[i];
    if (ai === undefined) {
      return -1;
    }
    if (bi === undefined) {
      return 1;
    }
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) {
        return diff;
      }
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

export function compareParsed(a: ParsedSemver, b: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }
  if (a.pre === null && b.pre === null) {
    return 0;
  }
  if (a.pre === null) {
    return 1;
  }
  if (b.pre === null) {
    return -1;
  }
  return comparePreRelease(a.pre, b.pre);
}
