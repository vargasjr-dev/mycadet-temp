/**
 * The self-hosted assistant's cloud registration web: register (or
 * re-confirm) the assistant with the platform, resolve which API key to
 * hand it, and inject the credentials into its running secret store — the
 * post-login half of the desktop app's LocalAssistantBootstrapService
 * flow. `registerLocalAssistantWithCloud` is the one door; `cadet hatch`
 * and `cadet login` both end here so the two injection paths cannot drift.
 */
import {
  type CloudCredentialVerificationStatus,
  CloudVerifyCredentialResponseSchema,
} from "@mycadet/service-contracts/cloud-credential";
import { z } from "zod";

import { fetchOrganizationId, readCloudToken } from "./cloud-auth";
import { getCloudBaseUrl } from "@mycadet/shared";
import { computeDeviceId, loadGuardianToken } from "./guardian-token";
import { saveLockfileAssistant } from "./lockfile";
import { getGatewayUrl, type LockfileAssistant } from "./lockfile-contract";
import { loopbackSafeFetch } from "./loopback-fetch";
import { checkHealth } from "./daemon-readiness";
import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
} from "./operations/lookup";

/** The guardian bearer recorded beside the lockfile, for gateway calls. */
function guardianBearer(assistantId: string): string | undefined {
  return loadGuardianToken(assistantId)?.accessToken;
}

/** The CLI's active-assistant resolution: explicit name, the active
 * pointer, then the single-entry fallback. */
function resolveAssistant(): LockfileAssistant | null {
  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
  }
  const all = loadAllAssistants();
  if (all.length === 1) return all[0];
  return null;
}

export interface EnsureRegistrationResponse {
  assistant: { id: string; name: string };
  registration: {
    client_installation_id: string;
    runtime_assistant_id: string;
    client_platform: string;
  };
  assistant_api_key: string | null;
  webhook_secret: string;
}

/**
 * Register (or re-confirm) a self-hosted local assistant with the cloud.
 *
 * Calls `POST /v1/assistants/self-hosted-local/ensure-registration/`.
 * The endpoint is idempotent: the first call provisions an API key;
 * subsequent calls return `assistant_api_key: null`.
 */
export async function ensureSelfHostedLocalRegistration(
  token: string,
  organizationId: string,
  clientInstallationId: string,
  runtimeAssistantId: string,
  clientPlatform: string,
  assistantVersion?: string,
  cloudUrl?: string,
  publicBaseUrl?: string,
): Promise<EnsureRegistrationResponse> {
  const resolvedUrl = cloudUrl || getCloudBaseUrl();
  const body: Record<string, string> = {
    client_installation_id: clientInstallationId,
    runtime_assistant_id: runtimeAssistantId,
    client_platform: clientPlatform,
  };
  if (assistantVersion) {
    body.assistant_version = assistantVersion;
  }
  if (publicBaseUrl) {
    body.public_ingress_url = publicBaseUrl;
  }

  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/assistants/self-hosted-local/ensure-registration/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Session-Token": token,
        "Cadet-Organization-Id": organizationId,
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 401 || response.status === 403) {
    throw new Error("Authentication required for assistant registration.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Registration failed (${response.status}): ${detail || response.statusText}`,
    );
  }

  return (await response.json()) as EnsureRegistrationResponse;
}

export interface ReprovisionApiKeyResponse {
  provisioning: {
    assistant_api_key: string;
  };
}

/**
 * Reprovision (rotate) the API key for a self-hosted local assistant.
 *
 * Calls `POST /v1/assistants/self-hosted-local/reprovision-api-key/`.
 * Returns a fresh API key. The cloud keeps the previous key valid for a
 * grace period rather than revoking it on the spot, so a rotation whose
 * replacement never gets stored leaves the assistant on a key that still
 * works until that window closes.
 */
export async function reprovisionAssistantApiKey(
  token: string,
  organizationId: string,
  clientInstallationId: string,
  runtimeAssistantId: string,
  clientPlatform: string,
  cloudUrl?: string,
): Promise<ReprovisionApiKeyResponse> {
  const resolvedUrl = cloudUrl || getCloudBaseUrl();
  const body: Record<string, string> = {
    client_installation_id: clientInstallationId,
    runtime_assistant_id: runtimeAssistantId,
    client_platform: clientPlatform,
  };

  const response = await loopbackSafeFetch(
    `${resolvedUrl}/v1/assistants/self-hosted-local/reprovision-api-key/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Session-Token": token,
        "Cadet-Organization-Id": organizationId,
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 401 || response.status === 403) {
    throw new Error("Authentication required for API key reprovisioning.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `API key reprovisioning failed (${response.status}): ${detail || response.statusText}`,
    );
  }

  return ReprovisionApiKeyResponseSchema.parse(await response.json());
}

const ReprovisionApiKeyResponseSchema = z.object({
  provisioning: z.object({ assistant_api_key: z.string() }),
});

const SecretReadResponseSchema = z
  .object({
    found: z.boolean(),
    value: z.string().optional(),
    unreachable: z.boolean().optional(),
  })
  .catch({ found: false });

export interface GatewayCredentialResult {
  /** The credential value, if found. */
  value: string | null;
  /** True when the gateway/daemon was unreachable (network error, timeout, etc.). */
  unreachable: boolean;
}

/**
 * Ask a running assistant to check its stored cloud credential against the
 * platform, via the gateway-proxied `POST /v1/cloud/verify-credential`.
 *
 * Returns `"rejected"` only when the cloud settled that answer. Every other
 * case, including a daemon too old to serve the route and any failure to reach
 * one, returns null: the answer decides whether a key is rotated, so an absent
 * answer must never read as a rejection.
 *
 * Never throws.
 */
export async function verifyGatewayCloudCredential(
  gatewayUrl: string,
  bearerToken?: string,
): Promise<CloudCredentialVerificationStatus | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const response = await loopbackSafeFetch(
      `${gatewayUrl}/v1/cloud/verify-credential`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return null;
    }

    const parsed = CloudVerifyCredentialResponseSchema.safeParse(
      await response.json(),
    );
    if (parsed.success) {
      return parsed.data.status;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read an existing credential from the assistant's secret store via the
 * gateway-proxied `POST /v1/secrets/read` endpoint (with `reveal: true`).
 *
 * Returns a result distinguishing a key-not-found read (value null,
 * unreachable false) from a gateway-unreachable read (value null,
 * unreachable true). Callers should only reprovision when the gateway
 * is reachable: the cloud keeps the outgoing key valid for a grace
 * period, so reprovisioning while the gateway is down does not break the
 * assistant immediately, but it starts a clock on a key the caller cannot
 * yet replace.
 *
 * Never throws.
 */
export async function readGatewayCredential(
  gatewayUrl: string,
  name: string,
  bearerToken?: string,
): Promise<GatewayCredentialResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const response = await loopbackSafeFetch(`${gatewayUrl}/v1/secrets/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "credential", name, reveal: true }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // 5xx means the gateway/daemon backend is down — treat as unreachable
      // so callers don't rotate away from a working key they cannot replace.
      return { value: null, unreachable: response.status >= 500 };
    }

    const json = SecretReadResponseSchema.parse(await response.json());
    // The daemon's /v1/secrets/read returns `unreachable: true` when the
    // credential backend (CES) can't be reached. Respect that signal.
    if (json.unreachable) {
      return { value: null, unreachable: true };
    }
    return {
      value: json.found && json.value ? json.value : null,
      unreachable: false,
    };
  } catch {
    // Network error, timeout, or gateway down
    return { value: null, unreachable: true };
  }
}

/**
 * Inject a single credential into the assistant's secret store via the
 * gateway's `POST /v1/secrets` endpoint.
 *
 * Mirrors the desktop app's `GatewayHTTPClient.post(path: "secrets", …)`
 * calls in `LocalAssistantBootstrapService.swift`.
 */
async function injectGatewayCredential(
  gatewayUrl: string,
  name: string,
  value: string,
  bearerToken?: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  const response = await loopbackSafeFetch(`${gatewayUrl}/v1/secrets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "credential", name, value }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

export interface CredentialInjectionParams {
  gatewayUrl: string;
  bearerToken?: string;
  assistantApiKey?: string | null;
  cloudAssistantId: string;
  organizationId: string;
  userId?: string;
  webhookSecret?: string | null;
}

/**
 * Inject cloud credentials into a running assistant via the gateway,
 * mirroring `LocalAssistantBootstrapService.injectKeyIntoAssistant` et al.
 *
 * Each credential is posted individually. Failures are collected but do
 * not prevent the remaining credentials from being injected.
 *
 * Returns true if all injections succeeded.
 */
export async function injectCredentialsIntoAssistant(
  params: CredentialInjectionParams,
): Promise<boolean> {
  const inject = (name: string, value: string) =>
    injectGatewayCredential(params.gatewayUrl, name, value, params.bearerToken);

  const promises: Promise<boolean>[] = [];

  if (params.assistantApiKey) {
    promises.push(inject("cadet:assistant_api_key", params.assistantApiKey));
  }

  if (params.webhookSecret) {
    promises.push(inject("cadet:webhook_secret", params.webhookSecret));
  }

  const results = await Promise.all(promises);
  return results.every(Boolean);
}

/** Where the key came from, so callers can report what they did. */
export type AssistantApiKeySource =
  | "registration"
  | "stored"
  | "reprovisioned"
  | "unavailable";

export interface ResolveAssistantApiKeyArgs {
  /** Key the registration returned, set only when it had none before. */
  registrationApiKey: string | null;
  runtimeUrl: string;
  bearerToken?: string;
  token: string;
  organizationId: string;
  clientInstallationId: string;
  runtimeAssistantId: string;
  clientPlatform: string;
}

export interface ResolvedAssistantApiKey {
  apiKey: string | null;
  source: AssistantApiKeySource;
}

/**
 * Three steps, in order: the key the registration just issued, the key the
 * assistant already holds, then a rotation.
 *
 * A stored key the cloud has rejected is skipped, because reinjecting it
 * repairs nothing while looking like a repair. The verdict is asked for
 * before the key is read, so the key returned is one the verdict covers: a
 * repair that lands between the two requests is then read, not overwritten
 * by the value it replaced. Rotation is still withheld when the gateway is
 * merely unreachable: rotating without being able to store the replacement
 * would start the cloud's grace clock on a key the assistant still needs,
 * with nothing to hand it in exchange.
 */
export async function resolveAssistantApiKeyForInjection(
  args: ResolveAssistantApiKeyArgs,
): Promise<ResolvedAssistantApiKey> {
  if (args.registrationApiKey) {
    return { apiKey: args.registrationApiKey, source: "registration" };
  }

  const status = await verifyGatewayCloudCredential(
    args.runtimeUrl,
    args.bearerToken,
  );
  // A settled rejection came from a gateway that answered, so the
  // replacement can be stored; the rejected key is not worth reading.
  if (status !== "rejected") {
    const cached = await readGatewayCredential(
      args.runtimeUrl,
      "cadet:assistant_api_key",
      args.bearerToken,
    );
    if (cached.value) {
      return { apiKey: cached.value, source: "stored" };
    }
    if (cached.unreachable) {
      return { apiKey: null, source: "unavailable" };
    }
  }

  const reprovision = await reprovisionAssistantApiKey(
    args.token,
    args.organizationId,
    args.clientInstallationId,
    args.runtimeAssistantId,
    args.clientPlatform,
  );
  return {
    apiKey: reprovision.provisioning.assistant_api_key,
    source: "reprovisioned",
  };
}

/**
 * The self-hosted assistant's own ingress URL, read from its running
 * gateway (`/integrations/ingress/config`). Managed-callback URLs belong
 * to the cloud, not the assistant, and yield undefined. Best-effort:
 * any failure is undefined.
 */
export async function fetchAssistantIngressUrl(
  runtimeUrl: string,
  bearerToken?: string,
): Promise<string | undefined> {
  if (!bearerToken) return undefined;
  try {
    const resp = await loopbackSafeFetch(
      `${runtimeUrl}/integrations/ingress/config`,
      {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (resp.ok) {
      const body = (await resp.json()) as {
        publicBaseUrl?: string;
        managedCallbacks?: boolean;
      };
      // Ignore managed-callback URLs — those belong to the cloud, not the
      // self-hosted assistant's own ingress.
      if (body.managedCallbacks) return undefined;
      return body.publicBaseUrl || undefined;
    }
  } catch {
    // Best-effort
  }
  return undefined;
}

export interface PlatformUser {
  id: string;
  email: string;
  display: string;
}

const AllauthSessionResponseSchema = z.object({
  status: z.number(),
  data: z.object({
    user: z.object({ id: z.string(), email: z.string(), display: z.string() }),
  }),
});

const PLATFORM_FETCH_TIMEOUT_MS = 10_000;

export async function fetchCurrentUser(
  token: string,
  cloudUrl?: string,
): Promise<PlatformUser> {
  const resolvedUrl = cloudUrl || getCloudBaseUrl();
  const url = `${resolvedUrl}/_allauth/app/v1/auth/session`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    PLATFORM_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers: { "X-Session-Token": token },
    });

    if (!response.ok) {
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 410
      ) {
        throw new Error("Invalid or expired token. Please login again.");
      }
      throw new Error(
        `Platform API error: ${response.status} ${response.statusText}`,
      );
    }

    const body = AllauthSessionResponseSchema.parse(await response.json());
    return body.data.user;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Register the active self-hosted assistant with the cloud and inject
 * cloud credentials into its runtime. Non-fatal by design; callers log
 * failures. Reads the cloud session token and the guardian bearer from
 * their disk files.
 */
export async function registerLocalAssistantWithCloud(
  user: { id: string; email: string },
  log: (message: string) => void = console.log,
): Promise<void> {
  // Both credentials come from disk: the cloud session token saved by
  // `cadet login`, and the guardian bearer beside the lockfile — the same
  // credential the assistant's gateway leases.
  const token = readCloudToken();
  if (!token) return;
  const entry = resolveAssistant();

  // Skip managed ("cadet") assistants — they are handled by the cloud.
  if (!entry || entry.cloud === "cloud") return;

  const gatewayUrl = getGatewayUrl(entry);

  const orgId = await fetchOrganizationId(token);
  const clientInstallationId = computeDeviceId();
  const [assistantVersion, ingressUrl] = await Promise.all([
    (await checkHealth(entry)).version,
    fetchAssistantIngressUrl(gatewayUrl, guardianBearer(entry.assistantId)),
  ]);
  const cloudUrl = getCloudBaseUrl();
  const registration = await ensureSelfHostedLocalRegistration(
    token,
    orgId,
    clientInstallationId,
    entry.assistantId,
    "cli",
    assistantVersion,
    cloudUrl,
    ingressUrl,
  );
  saveLockfileAssistant({
    ...entry,
    cloudAssistantId: registration.assistant.id,
    cloudOrganizationId: orgId,
  });
  log(
    `Registered assistant: ${registration.assistant.name} (${registration.assistant.id})`,
  );

  // Which key to hand the assistant, and why. Shared with teleport so
  // the two injection paths cannot drift.
  const resolved = await resolveAssistantApiKeyForInjection({
    registrationApiKey: registration.assistant_api_key,
    runtimeUrl: gatewayUrl,
    bearerToken: guardianBearer(entry.assistantId),
    token,
    organizationId: orgId,
    clientInstallationId,
    runtimeAssistantId: entry.assistantId,
    clientPlatform: "cli",
  });
  const assistantApiKey = resolved.apiKey;
  if (resolved.source === "reprovisioned") {
    log("Provisioning a replacement API key...");
  }

  // Inject credentials into the running assistant via the gateway,
  // mirroring the desktop app's LocalAssistantBootstrapService flow.
  const allInjected = await injectCredentialsIntoAssistant({
    gatewayUrl: gatewayUrl,
    bearerToken: guardianBearer(entry.assistantId),
    assistantApiKey,
    cloudAssistantId: registration.assistant.id,
    organizationId: orgId,
    userId: user.id,
    webhookSecret: registration.webhook_secret,
  });
  if (allInjected) {
    log("Injected cloud credentials into assistant.");
  } else {
    console.warn("Some credentials could not be injected into the assistant.");
  }
}
