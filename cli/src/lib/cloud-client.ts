import {
  chmodSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";

import {
  cloudAuthHeaders,
  cloudTokenPath,
  getCloudUrl,
  loopbackSafeFetch,
} from "@mycadet/local-mode";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { z } from "zod";

const InProgressResponseSchema = z.object({
  in_progress: z.boolean().optional(),
});

export function getWebUrl(): string {
  return process.env.CADET_WEB_URL?.trim() || getCurrentEnvironment().webUrl;
}

export function saveCloudToken(token: string): void {
  const tokenPath = cloudTokenPath();
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
}

export function clearCloudToken(): void {
  try {
    unlinkSync(cloudTokenPath());
  } catch {
    // already doesn't exist
  }
}

export interface HatchedAssistant {
  id: string;
  name: string;
  status: string;
}

const HatchedAssistantSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

const HatchedListResponseSchema = z.object({
  results: z.array(HatchedAssistantSchema).optional(),
});

const AssistantDetailResponseSchema = z.object({
  current_release_version: z.string().nullable().optional(),
});

const VersionCheckResponseSchema = z
  .object({
    detail: z.string().optional(),
    version: z.string().nullable().optional(),
  })
  .catch({});

const CLOUD_FETCH_TIMEOUT_MS = 10_000;

/**
 * Lightweight pre-check: returns the first active cloud assistant for the
 * authenticated user, or `null` if none exists. Calls `GET /v1/assistants/`
 * and looks for any assistant with status "active".
 *
 * Used by the teleport flow to block BEFORE the expensive GCS upload when
 * the user already has a cloud assistant.
 */
export async function checkExistingCloudAssistant(
  token: string,
  cloudUrl?: string,
): Promise<HatchedAssistant | null> {
  const resolvedUrl = cloudUrl || getCloudUrl();
  const url = `${resolvedUrl}/v1/assistants/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CLOUD_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers: await cloudAuthHeaders(token, cloudUrl),
    });

    if (!response.ok) {
      // Non-fatal: if the list call fails, fall through and let hatch handle it.
      return null;
    }

    const parsed = HatchedListResponseSchema.safeParse(await response.json());
    const results = parsed.success ? parsed.data.results : undefined;
    return results?.find((a) => a.status === "active") ?? null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch all active assistants for the authenticated user from the cloud.
 * Returns an empty array on failure (non-fatal).
 */
export async function fetchCloudAssistants(
  token: string,
  cloudUrl?: string,
): Promise<HatchedAssistant[]> {
  const resolvedUrl = cloudUrl || getCloudUrl();
  const url = `${resolvedUrl}/v1/assistants/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CLOUD_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers: await cloudAuthHeaders(token, cloudUrl),
    });

    if (!response.ok) return [];

    const parsed = HatchedListResponseSchema.safeParse(await response.json());
    const results = parsed.success ? (parsed.data.results ?? []) : [];

    return results.filter((a) => a.status === "active");
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface CloudAssistantDetail {
  currentReleaseVersion: string | null;
}

/**
 * Fetch a single assistant's upgrade-relevant fields from
 * `GET /v1/assistants/{id}/`. Returns null on any failure (best-effort
 * pre-flight / polling helper — never throws).
 */
export async function fetchAssistantDetail(
  token: string,
  assistantId: string,
  cloudUrl?: string,
): Promise<CloudAssistantDetail | null> {
  const resolvedUrl = cloudUrl || getCloudUrl();
  const url = `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/`;

  try {
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      headers: await cloudAuthHeaders(token, cloudUrl),
    });

    if (!response.ok) return null;

    const parsed = AssistantDetailResponseSchema.safeParse(
      await response.json(),
    );
    const body = parsed.success ? parsed.data : {};
    return {
      currentReleaseVersion: body.current_release_version ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Check whether the cloud reports an upgrade in progress for the
 * assistant via `GET /v1/assistants/{id}/upgrade-status/`. Returns null
 * when the endpoint is unavailable (404 on older platforms, network
 * error) so callers can skip the check. Never throws.
 */
export async function fetchUpgradeInProgress(
  token: string,
  assistantId: string,
  cloudUrl?: string,
): Promise<boolean | null> {
  const resolvedUrl = cloudUrl || getCloudUrl();
  const url = `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/upgrade-status/`;

  try {
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      headers: await cloudAuthHeaders(token, cloudUrl),
    });

    if (!response.ok) return null;

    const parsed = InProgressResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.in_progress !== undefined
      ? parsed.data.in_progress
      : null;
  } catch {
    return null;
  }
}

export async function rollbackCloudAssistant(
  token: string,
  assistantId: string,
  version?: string,
  cloudUrl?: string,
): Promise<{ detail: string; version: string | null }> {
  const resolvedUrl = cloudUrl || getCloudUrl();
  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/rollback/`,
    {
      method: "POST",
      headers: await cloudAuthHeaders(token, cloudUrl),
      body: JSON.stringify(version ? { version } : {}),
    },
  );

  const body = VersionCheckResponseSchema.parse(
    await response.json().catch(() => ({})),
  );

  if (response.status === 200) {
    return { detail: body.detail ?? "", version: body.version ?? null };
  }

  if (response.status === 400) {
    throw new Error(body.detail ?? "Rollback failed: bad request");
  }

  if (response.status === 404) {
    throw new Error(body.detail ?? "Rollback target not found");
  }

  if (response.status === 502) {
    throw new Error(body.detail ?? "Rollback failed: transport error");
  }

  throw new Error(`Rollback failed: ${response.status} ${response.statusText}`);
}
