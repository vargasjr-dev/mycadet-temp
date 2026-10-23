/**
 * Bound platform identity (assistant, organization, user).
 *
 * The cloud maps an assistant API key to these ids via
 * `POST /v1/internal/assistants/validate/`. Process startup rehydrates from
 * that endpoint into the in-memory overrides. Resolution reads only those
 * overrides. When the in-memory assistant id is empty, the next resolve
 * retries validate (single-flight, with a cooldown after a failed attempt
 * that holds only while the same API key and base URL are stored).
 */

import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  getCloudAssistantId,
  getCloudBaseUrl,
  getCloudOrganizationId,
  getCloudUserId,
  setCloudAssistantId,
  setCloudOrganizationId,
  setCloudUserId,
} from "./env.js";

const log = getLogger("cloud-identity");

export const CLOUD_IDENTITY_VALIDATE_PATH = "/v1/internal/assistants/validate/";

const VALIDATE_TIMEOUT_MS = 5_000;
const ENSURE_COOLDOWN_MS = 10_000;

export type CloudIdentityIds = {
  assistantId: string;
  organizationId: string;
  userId: string;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function applyCloudIdentityIds(ids: CloudIdentityIds): void {
  if (ids.assistantId) {
    setCloudAssistantId(ids.assistantId);
  }
  if (ids.organizationId) {
    setCloudOrganizationId(ids.organizationId);
  }
  if (ids.userId) {
    setCloudUserId(ids.userId);
  }
}

/**
 * Trade an assistant API key for the bound platform ids.
 *
 * Returns null when the cloud is unreachable, refuses the key, or the
 * body has no ids. Never throws.
 */
export async function fetchCloudIdentityIds(
  baseUrl: string,
  apiKey: string,
): Promise<CloudIdentityIds | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}${CLOUD_IDENTITY_VALIDATE_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status },
        "platform identity validate returned non-2xx",
      );
      return null;
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") {
      return null;
    }
    const obj = body as Record<string, unknown>;
    const assistantId = asNonEmptyString(obj.assistant_id);
    const organizationId = asNonEmptyString(obj.organization_id);
    const userId = asNonEmptyString(obj.user_id);
    if (!assistantId && !organizationId && !userId) {
      return null;
    }
    return {
      assistantId: assistantId ?? "",
      organizationId: organizationId ?? "",
      userId: userId ?? "",
    };
  } catch (err) {
    log.warn({ err }, "platform identity validate failed");
    return null;
  }
}

async function readAssistantApiKey(): Promise<string> {
  try {
    const stored = (
      await getSecureKeyAsync(credentialKey("cadet", "assistant_api_key"))
    )?.trim();
    if (stored) {
      return stored;
    }
  } catch (err) {
    log.warn({ err }, "failed to read assistant API key from credential store");
  }
  return process.env.ASSISTANT_API_KEY?.trim() ?? "";
}

let ensureInFlight: Promise<void> | null = null;
// The cooldown is bound to the credentials that failed: the same key against
// the same base URL is not re-sent for ENSURE_COOLDOWN_MS, while a change to
// either is validated on the next resolve.
let failedFingerprint: string | null = null;
let nextEnsureAttemptAt = 0;

function identityFingerprint(apiKey: string, baseUrl: string): string {
  return `${baseUrl}\0${apiKey}`;
}

export function _resetCloudIdentityEnsureForTests(): void {
  ensureInFlight = null;
  failedFingerprint = null;
  nextEnsureAttemptAt = 0;
}

/**
 * Load in-memory platform ids from validate when they are missing.
 *
 * No-ops when the assistant id is already set, when auth prerequisites are
 * missing, or when the stored API key and base URL are the ones a failed
 * attempt used and that attempt is still inside the cooldown window.
 * Concurrent callers share one in-flight request.
 */
export async function ensureCloudIdentityIds(): Promise<void> {
  if (getCloudAssistantId()?.trim()) {
    return;
  }
  if (!ensureInFlight) {
    ensureInFlight = (async () => {
      try {
        const apiKey = await readAssistantApiKey();
        const baseUrl = (getCloudBaseUrl() ?? "").replace(/\/+$/, "");
        if (!apiKey || !baseUrl) {
          return;
        }
        const fingerprint = identityFingerprint(apiKey, baseUrl);
        if (
          fingerprint === failedFingerprint &&
          Date.now() < nextEnsureAttemptAt
        ) {
          return;
        }
        const ids = await fetchCloudIdentityIds(baseUrl, apiKey);
        if (!ids) {
          failedFingerprint = fingerprint;
          nextEnsureAttemptAt = Date.now() + ENSURE_COOLDOWN_MS;
          return;
        }
        applyCloudIdentityIds(ids);
        failedFingerprint = null;
        nextEnsureAttemptAt = 0;
        log.info("Loaded platform identity from platform validate");
      } catch (err) {
        // Startup rehydration must never take a process down: an
        // unreachable credential store only means identity is not bound
        // yet, and the next resolve retries.
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to ensure cloud identity ids (non-fatal)",
        );
      } finally {
        ensureInFlight = null;
      }
    })();
  }
  await ensureInFlight;
}

export async function resolveCloudAssistantId(): Promise<string> {
  const existing = getCloudAssistantId()?.trim() ?? "";
  if (existing) {
    return existing;
  }
  await ensureCloudIdentityIds();
  return getCloudAssistantId()?.trim() ?? "";
}

export async function resolveCloudAssistantIdOrNull(): Promise<string | null> {
  const id = await resolveCloudAssistantId();
  return id || null;
}

export async function resolveCloudOrganizationId(): Promise<string> {
  const existing = getCloudOrganizationId()?.trim() ?? "";
  if (existing) {
    return existing;
  }
  await ensureCloudIdentityIds();
  return getCloudOrganizationId()?.trim() ?? "";
}

export async function resolveCloudUserId(): Promise<string> {
  const existing = getCloudUserId()?.trim() ?? "";
  if (existing) {
    return existing;
  }
  await ensureCloudIdentityIds();
  return getCloudUserId()?.trim() ?? "";
}
