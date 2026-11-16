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
  loopbackSafeFetch,
} from "@mycadet/local-mode";
import { getCloudBaseUrl } from "@mycadet/shared";
import { z } from "zod";

const InProgressResponseSchema = z.object({
  in_progress: z.boolean().optional(),
});

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

// The operator contract's list union (local-mode runListRoute): every row
// the account owns as a choice, or the empty arm. The list's rows are
// usable choices — readiness verdicts come from the scoped dial, not the
// list — so each listed row reads back as active.
const AssistantListUnionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({
    status: z.literal("selection"),
    assistants: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
]);

// The chooser's list body: rows are usable choices — a non-union body (or
// the empty arm) is a non-fatal empty list.
function decodeAssistantList(body: unknown): HatchedAssistant[] {
  const union = AssistantListUnionSchema.safeParse(body);
  if (!union.success) return [];
  return union.data.status === "selection"
    ? union.data.assistants.map((row) => ({
        id: row.id,
        name: row.name,
        status: "active",
      }))
    : [];
}

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
 * Fetch the authenticated user's cloud assistants — the operator contract's
 * list union (local-mode runListRoute). Returns an empty array on failure
 * (non-fatal).
 */
export async function fetchCloudAssistants(
  token: string,
): Promise<HatchedAssistant[]> {
  const resolvedUrl = getCloudBaseUrl();
  const url = `${resolvedUrl}/v1/assistants/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CLOUD_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers: await cloudAuthHeaders(token),
    });

    if (!response.ok) return [];

    return decodeAssistantList(await response.json().catch(() => null));
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
): Promise<CloudAssistantDetail | null> {
  const resolvedUrl = getCloudBaseUrl();
  const url = `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/`;

  try {
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      headers: await cloudAuthHeaders(token),
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
): Promise<boolean | null> {
  const resolvedUrl = getCloudBaseUrl();
  const url = `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/upgrade-status/`;

  try {
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      headers: await cloudAuthHeaders(token),
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
): Promise<{ detail: string; version: string | null }> {
  const resolvedUrl = getCloudBaseUrl();
  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/assistants/${encodeURIComponent(assistantId)}/rollback/`,
    {
      method: "POST",
      headers: await cloudAuthHeaders(token),
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
