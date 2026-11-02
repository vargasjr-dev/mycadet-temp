import { getCloudRuntimeUrl } from "@/lib/cloud-runtime-url";
import type { CloudStatusGetResponses } from "@/generated/daemon/types.gen";
import { CloudIdentityInjectionError } from "@/lib/cloud-identity-errors";
import { buildCadetMutatingHeaders } from "@/lib/auth/request-headers";
import {
  getActiveAssistant,
  isLocalAssistant,
  isLocalClient,
  primeLocalGatewayConnection,
} from "@/lib/local-mode";
import { isLoopbackGatewayCloud } from "@mycadet/local-mode/contract";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { getDeviceId } from "@/runtime/device-id";
import { detectElectronHostOS } from "@/runtime/platform-detection";
import { getElectronSessionToken } from "@/runtime/session-token";
import { isUuid } from "@/utils/uuid";

const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

type LocalCloudStatus = {
  assistantId: string | null;
  baseUrl: string | null;
  organizationId: string | null;
  hasAssistantApiKey: boolean | null;
  clientInstallationId: string | null;
};

type EnsureRegistrationResponse = {
  id?: unknown;
  assistant_id?: unknown;
  assistant?: {
    id?: unknown;
    name?: unknown;
  };
  assistant_api_key?: unknown;
  webhook_secret?: unknown;
};

type ReprovisionApiKeyResponse = {
  provisioning?: {
    assistant_api_key?: unknown;
  };
};

type ResolveLocalAssistantCloudIdentityOptions = {
  allowGatewayRepair?: boolean;
  /**
   * Whether a stored credential the cloud has rejected may be rotated.
   *
   * Off by default, so a routine resolution never replaces a credential
   * unattended. Rotation is a credential mutation and the user is the one who
   * asks for it, by signing in from the CLI.
   */
  rotateRejectedCredential?: boolean;
};

const cloudAssistantIdCache = new Map<string, Promise<string>>();

/**
 * A key the cloud issued for an assistant that has not been stored yet,
 * by runtime assistant id. Every reprovision puts the key the assistant holds
 * on the cloud's grace clock, so a bootstrap whose store write failed
 * stores this key on its next attempt rather than asking for another; a
 * repair always asks, because it was asked to. Cleared once the write lands.
 */
const unstoredProvisionedKeys = new Map<string, string>();

export async function resolveLocalAssistantCloudIdentity(
  assistantId: string,
  options: ResolveLocalAssistantCloudIdentityOptions = {},
): Promise<string> {
  if (!isLocalClient() || isUuid(assistantId)) {
    return assistantId;
  }

  // A repair acts on any assistant this client reaches over the local
  // gateway; bootstrap provisions only the ones the web lifecycle owns.
  const assistant = resolveLocalAssistant(
    assistantId,
    options.rotateRejectedCredential
      ? (a) => isLoopbackGatewayCloud(a.cloud)
      : isLocalAssistant,
  );
  if (!assistant) {
    return assistantId;
  }

  const cached = cloudAssistantIdCache.get(assistant.assistantId);
  if (cached) {
    return cached;
  }

  const promise = ensureLocalAssistantCloudIdentity(assistant, {
    allowGatewayRepair: options.allowGatewayRepair ?? true,
    rotateRejectedCredential: options.rotateRejectedCredential ?? false,
  });
  cloudAssistantIdCache.set(assistant.assistantId, promise);
  try {
    return await promise;
  } catch (error) {
    cloudAssistantIdCache.delete(assistant.assistantId);
    throw error;
  }
}

/**
 * The lockfile entry for `assistantId` when it is the active or selected
 * assistant and `eligible` accepts it, else null. The routine resolution
 * passes `isLocalAssistant`, the assistants the web lifecycle owns; a
 * credential-rotating one passes every loopback-gateway assistant.
 */
function resolveLocalAssistant(
  assistantId: string,
  eligible: (assistant: LockfileAssistant) => boolean,
): LockfileAssistant | null {
  const active = getActiveAssistant();
  if (active?.assistantId === assistantId && eligible(active)) {
    return active;
  }
  const selected = getActiveAssistant();
  if (selected?.assistantId === assistantId && eligible(selected)) {
    return selected;
  }
  return null;
}

async function ensureLocalAssistantCloudIdentity(
  assistant: LockfileAssistant,
  options: { allowGatewayRepair: boolean; rotateRejectedCredential: boolean },
): Promise<string> {
  const gateway = await ensureGatewayAccess(assistant, options);
  const status = await fetchCloudStatus(gateway, assistant.assistantId);
  // No answer is not "no key". A daemon that is still starting cannot store a
  // credential either, and a reprovision it never receives starts the grace
  // clock on the key it holds. The bootstrap retries once it answers.
  if (!status) {
    throw new Error(
      "The local assistant did not answer its platform status, so nothing was provisioned.",
    );
  }
  const statusCloudAssistantId =
    status.assistantId && isUuid(status.assistantId)
      ? status.assistantId
      : null;
  // A stored key the cloud has rejected is worse than no key: every call
  // fails and the assistant cannot mint a replacement for itself. The cloud
  // leaves self-hosted and local registrations to their client on purpose
  // (`recover_expired_assistant_api_key` excludes them), so a repair here is
  // the only thing that rotates one.
  // A repair rotates because it was asked for, not because the daemon agrees
  // the credential is dead. The verdict is in-process and resets to `unknown`
  // when the daemon restarts, while the notification offering the repair
  // persists, so requiring a reported rejection would leave the button inert
  // in exactly the case it exists for: a dead credential surviving a restart.
  //
  // Rotating on request is safe. The cloud keeps the outgoing key valid for
  // a grace period, so a repair the credential did not need costs a rotation
  // and nothing else. Routine resolution never sets this and never rotates.
  const repairRequested = options.rotateRejectedCredential;

  if (
    statusCloudAssistantId &&
    status.hasAssistantApiKey !== false &&
    !repairRequested
  ) {
    // The registration is known but the daemon could not read its store, so
    // whether it holds a key is not. Settling here would end a bootstrap that
    // may still have a provisioned key to store, so this fails with the id
    // and the bootstrap retries once the store answers.
    if (status.hasAssistantApiKey === null) {
      throw new CloudIdentityInjectionError(
        statusCloudAssistantId,
        new Error(
          "The local assistant could not read its credential store, so nothing was provisioned.",
        ),
      );
    }
    return statusCloudAssistantId;
  }

  const organizationId = await resolveOrganizationId(
    status.organizationId ?? null,
    assistant,
  );
  if (!organizationId) {
    throw new Error(
      "Sign in to Cadet and select an organization to register this local assistant.",
    );
  }

  const clientInstallationId =
    status.clientInstallationId ?? getDeviceId() ?? null;
  if (!clientInstallationId) {
    throw new Error(
      "Unable to identify this local assistant host for platform registration.",
    );
  }

  const registration = await ensureRegistration(
    assistant,
    organizationId,
    clientInstallationId,
  );
  const registrationCloudAssistantId = firstString(
    registration.assistant?.id,
    registration.assistant_id,
    registration.id,
  );
  const cloudAssistantId =
    statusCloudAssistantId ?? registrationCloudAssistantId;
  if (!cloudAssistantId || !isUuid(cloudAssistantId)) {
    throw new Error(
      "The cloud registration response did not include an assistant UUID.",
    );
  }

  // `ensureRegistration` hands back a key only for a registration that had
  // none, so a repair needs the explicit rotation. The cloud keeps the
  // outgoing key valid for a grace period rather than revoking it on the spot,
  // so a rotation whose injection fails leaves the install no worse off.
  //
  // A rotation is asked for on a repair, or when the daemon has read its
  // store and found no key. A daemon that could not read its store reports
  // null, and that is not evidence either way: the key it may hold would be
  // put on the grace clock for nothing, and the replacement could not be
  // stored where the key was unreadable. The bootstrap retries instead.
  let assistantApiKey = stringValue(registration.assistant_api_key);
  if (!assistantApiKey) {
    if (repairRequested) {
      assistantApiKey = await reprovisionApiKey(
        assistant,
        organizationId,
        clientInstallationId,
      );
    } else if (status.hasAssistantApiKey === false) {
      assistantApiKey =
        unstoredProvisionedKeys.get(assistant.assistantId) ??
        (await reprovisionApiKey(
          assistant,
          organizationId,
          clientInstallationId,
        ));
    } else if (status.hasAssistantApiKey === null) {
      throw new Error(
        "The local assistant could not read its credential store, so nothing was provisioned.",
      );
    }
  }
  if (assistantApiKey) {
    unstoredProvisionedKeys.set(assistant.assistantId, assistantApiKey);
  }

  const cloudBaseUrl = status.baseUrl ?? getCloudRuntimeUrl();
  try {
    await injectCloudCredentials(gateway, {
      assistantApiKey,
      cloudBaseUrl,
      webhookSecret: stringValue(registration.webhook_secret),
    });
    unstoredProvisionedKeys.delete(assistant.assistantId);
  } catch (error) {
    // The registration is real even though the local side is not finished;
    // hand its id to callers that only need the cloud to know the
    // assistant, and let the retrying bootstrap complete the injection.
    throw new CloudIdentityInjectionError(cloudAssistantId, error);
  }

  return cloudAssistantId;
}

async function ensureGatewayAccess(
  assistant: LockfileAssistant,
  options: { allowGatewayRepair: boolean },
): Promise<{ gatewayUrl: string; actorToken: string }> {
  let gatewayUrl = getSelfHostedIngressUrl();
  let actorToken = getSelfHostedActorToken();

  if (options.allowGatewayRepair && (!gatewayUrl || !actorToken)) {
    await primeLocalGatewayConnection(assistant);
    gatewayUrl = getSelfHostedIngressUrl();
    actorToken = getSelfHostedActorToken();
  }

  if (!gatewayUrl || !actorToken) {
    // The scoped data plane is plain same-origin /v1 — the host routes it by
    // the id in the path, so the bare origin reaches any local assistant.
    gatewayUrl = window.location.origin;
  }

  if (!gatewayUrl || !actorToken) {
    throw new Error(
      "Unable to reach the local assistant for platform identity setup.",
    );
  }

  return { gatewayUrl, actorToken };
}

/**
 * The daemon's `cloud/status`, null on any failure. A null `actorToken`
 * sends no bearer: the paired proxy's trusted host installs its own.
 */
export async function fetchCloudStatus(
  gateway: { gatewayUrl: string; actorToken: string | null },
  runtimeAssistantId: string,
): Promise<LocalCloudStatus | null> {
  const url = gatewayUrl(
    gateway.gatewayUrl,
    `/v1/assistants/${encodeURIComponent(runtimeAssistantId)}/cloud/status`,
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(gateway.actorToken && {
        Authorization: `Bearer ${gateway.actorToken}`,
      }),
    },
    credentials: "omit",
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }

  // The daemon's own response shape. Partial because this bundle serves
  // daemons of any age, and a field the current schema requires may be absent
  // from an older one; absent reads as null, which the gates treat as unknown.
  const body = (await response.json().catch(() => null)) as Partial<
    CloudStatusGetResponses[200]
  > | null;
  return {
    assistantId: body?.assistantId ?? null,
    baseUrl: body?.baseUrl ?? null,
    organizationId: body?.organizationId ?? null,
    hasAssistantApiKey: body?.hasAssistantApiKey ?? null,
    clientInstallationId: body?.clientInstallationId ?? null,
  };
}

async function resolveOrganizationId(
  statusOrganizationId: string | null,
  assistant: LockfileAssistant,
): Promise<string | null> {
  return (
    statusOrganizationId ??
    (assistant.cloud === "custom" || assistant.cloud === "baseten"
      ? null
      : (assistant.cloudOrganizationId ?? null))
  );
}

async function ensureRegistration(
  assistant: LockfileAssistant,
  organizationId: string,
  clientInstallationId: string,
): Promise<EnsureRegistrationResponse> {
  return platformPost<EnsureRegistrationResponse>(
    "/v1/assistants/self-hosted-local/ensure-registration/",
    assistant,
    organizationId,
    clientInstallationId,
  );
}

async function reprovisionApiKey(
  assistant: LockfileAssistant,
  organizationId: string,
  clientInstallationId: string,
): Promise<string | null> {
  const body = await platformPost<ReprovisionApiKeyResponse>(
    "/v1/assistants/self-hosted-local/reprovision-api-key/",
    assistant,
    organizationId,
    clientInstallationId,
  );
  return stringValue(body.provisioning?.assistant_api_key);
}

async function platformPost<T>(
  path: string,
  assistant: LockfileAssistant,
  organizationId: string,
  clientInstallationId: string,
): Promise<T> {
  const headers = new Headers({
    ...(await buildCadetMutatingHeaders(
      {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      {
        includeSelfHostedActorToken: false,
      },
    )),
  });

  const sessionToken = getElectronSessionToken();
  const electronHostOS = detectElectronHostOS();
  if (electronHostOS) {
    if (!sessionToken) {
      throw new Error("Sign in to Cadet to register this local assistant.");
    }
    headers.set(
      ELECTRON_RENDERER_ORIGIN_HEADER,
      `${window.location.protocol}//${window.location.host}`,
    );
  }

  const response = await fetch(
    new URL(path, window.location.origin).toString(),
    {
      method: "POST",
      headers,
      credentials: electronHostOS ? "omit" : "same-origin",
      body: JSON.stringify({
        client_installation_id: clientInstallationId,
        runtime_assistant_id: assistant.assistantId,
        client_platform: electronHostOS ?? "web",
      }),
    },
  ).catch((error: unknown) => {
    throw new Error(
      `Unable to reach the cloud registration endpoint: ${errorMessage(error)}`,
    );
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Unable to register the local assistant with the cloud (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(
      `Unable to read the cloud registration response: ${errorMessage(error)}`,
    );
  }
}

async function injectCloudCredentials(
  gateway: { gatewayUrl: string; actorToken: string },
  params: {
    assistantApiKey: string | null;
    cloudBaseUrl: string;
    webhookSecret: string | null;
  },
): Promise<void> {
  const entries: Array<[string, string | null]> = [
    ["cadet:platform_base_url", params.cloudBaseUrl],
    ["cadet:webhook_secret", params.webhookSecret],
  ];

  await Promise.all(
    entries
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([name, value]) => injectCredential(gateway, name, value)),
  );

  // The API key is the sentinel the status probe reports as
  // has_assistant_api_key, and the bootstrap early-returns when it is
  // present. Store it only after every other credential has landed, so a
  // partial write can never look "healthy" to a later retry and suppress
  // the re-injection of the missing credentials.
  if (params.assistantApiKey) {
    await injectCredential(
      gateway,
      "cadet:assistant_api_key",
      params.assistantApiKey,
    );
  }
}

async function injectCredential(
  gateway: { gatewayUrl: string; actorToken: string },
  name: string,
  value: string,
): Promise<boolean> {
  const response = await fetch(gatewayUrl(gateway.gatewayUrl, "/v1/secrets"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${gateway.actorToken}`,
      "Content-Type": "application/json",
    },
    credentials: "omit",
    body: JSON.stringify({ type: "credential", name, value }),
  }).catch((error: unknown) => {
    throw new Error(
      `Unable to reach the local assistant while storing ${name}: ${errorMessage(error)}`,
    );
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Unable to store ${name} on the local assistant (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  return true;
}

async function readErrorDetail(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as unknown;
    const detail =
      body && typeof body === "object" && "detail" in body
        ? stringValue((body as { detail?: unknown }).detail)
        : null;
    const code =
      body && typeof body === "object" && "code" in body
        ? stringValue((body as { code?: unknown }).code)
        : null;
    if (detail && code) {
      return `${detail} (${code})`;
    }
    if (detail) {
      return detail;
    }
    if (code) {
      return code;
    }
    return JSON.stringify(body);
  }
  return (await response.text().catch(() => "")).slice(0, 300);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gatewayUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${path}`;
  return url.toString();
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = stringValue(value);
    if (string) {
      return string;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
