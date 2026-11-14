/**
 * Settings credential catalog — the underlying logic for
 * `credentials/list` (route + `assistant credentials list`).
 *
 * Shared by the daemon route handler AND the CLI, which dials this logic
 * directly instead of phoning home over IPC (the CLI's broader move away
 * from IPC transport). The CLI lazy-imports this module inside its action:
 * it is daemon-internal (it pulls the secure-key backend and the OAuth
 * store), so hoisting it into the CLI's static graph would violate
 * `cli/no-daemon-internals`.
 */

import {
  listConnections,
  type OAuthConnectionRow,
} from "../../oauth/oauth-store.js";
import { isCloudCredential } from "../../runtime/routes/cloud-credentials.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyResultAsync } from "../../security/secure-keys.js";
import {
  type CredentialMetadata,
  listCredentialRecordsLive,
} from "./metadata-store.js";

const CREDENTIAL_STORE_UNREACHABLE =
  "Credential store is unreachable. Retry in a moment, or check that the credential vault is running.";

export class CredentialStoreUnreachableError extends Error {
  constructor() {
    super(CREDENTIAL_STORE_UNREACHABLE);
    this.name = "CredentialStoreUnreachableError";
  }
}

export function scrubSecret(secret: string | undefined): string {
  if (secret == null || secret.length === 0) {
    return "(not set)";
  }
  if (secret.length <= 4) {
    return "****";
  }
  // Keep the leading 4 characters so vendor prefixes stay visible.
  return secret.slice(0, 4) + "****";
}

function safeListConnections(): OAuthConnectionRow[] {
  try {
    return listConnections();
  } catch {
    return [];
  }
}

export function buildCredentialOutput(
  metadata: CredentialMetadata,
  secret: string | undefined,
  connection?: OAuthConnectionRow,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    service: metadata.service,
    field: metadata.field,
    credentialId: metadata.credentialId,
    scrubbedValue: scrubSecret(secret),
    hasSecret: secret != null && secret.length > 0,
    alias: metadata.alias ?? null,
    usageDescription: metadata.usageDescription ?? null,
    allowedTools: metadata.allowedTools,
    allowedDomains: metadata.allowedDomains,
    createdAt: new Date(metadata.createdAt).toISOString(),
    updatedAt: new Date(metadata.updatedAt).toISOString(),
    injectionTemplateCount: metadata.injectionTemplates?.length ?? 0,
    grantedScopes: connection ? JSON.parse(connection.grantedScopes) : null,
    expiresAt: connection?.expiresAt
      ? new Date(connection.expiresAt).toISOString()
      : null,
  };

  if (connection) {
    output.oauthConnectionId = connection.id;
    output.oauthAccountInfo = connection.accountInfo ?? null;
    output.oauthStatus = connection.status;
    output.oauthHasRefreshToken = connection.hasRefreshToken === 1;
    output.oauthLabel = connection.label ?? null;
  }

  return output;
}

/**
 * List the user's credentials with metadata, OAuth enrichment, and a masked
 * value preview — the same shaping the daemon route returns.
 *
 * Cloud-provisioned credentials are excluded: they are not the user's to act
 * on, so they never become a Settings row (and never a click-to-reveal).
 *
 * Throws {@link CredentialStoreUnreachableError} when the vault cannot be
 * reached (an outage must not look like an empty catalog).
 */
export async function listSettingsCredentials(
  search?: string,
): Promise<Record<string, unknown>[]> {
  const live = await listCredentialRecordsLive();
  if (live.unreachable) {
    throw new CredentialStoreUnreachableError();
  }

  let allMetadata = live.records.filter(
    (m) => !isCloudCredential(m.service, m.field),
  );

  if (search) {
    const query = search.toLowerCase();
    allMetadata = allMetadata.filter((m) => {
      const service = m.service.toLowerCase();
      const field = m.field.toLowerCase();
      const alias = (m.alias ?? "").toLowerCase();
      const description = (m.usageDescription ?? "").toLowerCase();
      return (
        service.includes(query) ||
        field.includes(query) ||
        alias.includes(query) ||
        description.includes(query)
      );
    });
  }

  // Build a lookup of oauth connections keyed by provider for enrichment.
  const allConnections = safeListConnections();
  const connectionsByProvider = new Map<string, OAuthConnectionRow>();
  for (const conn of allConnections) {
    if (conn.status !== "active") {
      continue;
    }
    const existing = connectionsByProvider.get(conn.provider);
    if (!existing || conn.createdAt > existing.createdAt) {
      connectionsByProvider.set(conn.provider, conn);
    }
  }

  return Promise.all(
    allMetadata.map(async (m) => {
      const { value: secret, unreachable } = await getSecureKeyResultAsync(
        credentialKey(m.service, m.field),
      );
      if (unreachable) {
        throw new CredentialStoreUnreachableError();
      }
      const connection = connectionsByProvider.get(m.service);
      return buildCredentialOutput(m, secret, connection);
    }),
  );
}
