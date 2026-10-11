/**
 * Single source of truth for credential key format in the secure store.
 *
 * Keys follow the pattern: credential/{service}/{field}
 */

/**
 * Build a credential key for the secure store.
 *
 * @returns A key of the form `credential/{service}/{field}`
 */
export function credentialKey(service: string, field: string): string {
  return `credential/${service}/${field}`;
}

/**
 * Cloud-identity credential field names, with their legacy spellings.
 *
 * The Cadet Cloud provisions identity credentials straight into the vault
 * (the runtime has no write path for them — the secrets route rejects the
 * fields and the workspace importer skips `cadet:*`). Existing installs hold
 * the assistant id under the legacy `platform_*` spelling, so reads consult
 * both spellings and deletions clear both; the canonical `cloud_*` names are
 * what new data uses.
 */
export const CLOUD_IDENTITY_FIELDS = {
  assistantId: {
    canonical: "cloud_assistant_id",
    legacy: "platform_assistant_id",
  },
  organizationId: {
    canonical: "cloud_organization_id",
    legacy: "platform_organization_id",
  },
  userId: {
    canonical: "cloud_user_id",
    legacy: "platform_user_id",
  },
} as const;

/** Both spellings (canonical first, legacy last) of a cloud-identity field. */
export function cloudIdentityFieldSpellings(
  field: keyof typeof CLOUD_IDENTITY_FIELDS,
): [string, string] {
  const spellings = CLOUD_IDENTITY_FIELDS[field];
  return [spellings.canonical, spellings.legacy];
}

/** Map a legacy cloud-identity spelling to its canonical name; others pass through. */
export function normalizeCloudIdentityField(field: string): string {
  for (const spelling of Object.values(CLOUD_IDENTITY_FIELDS)) {
    if (field === spelling.legacy) {
      return spelling.canonical;
    }
  }
  return field;
}

/** True when `field` is any spelling (canonical or legacy) of a cloud-identity field. */
export function isCloudIdentityField(field: string): boolean {
  return Object.values(CLOUD_IDENTITY_FIELDS).some(
    (spelling) => field === spelling.canonical || field === spelling.legacy,
  );
}

/**
 * Normalize a credential reference to the vault-key form.
 *
 * The secrets API names credentials `{service}:{field}` on the wire (e.g.
 * `openrouter:api_key`), while the vault stores them as
 * `credential/{service}/{field}`. Callers routinely reuse the wire name where
 * a vault key is expected, producing references that never resolve. Map the
 * wire name to the vault key (same lastIndexOf split the secrets routes use);
 * leave anything else untouched.
 */
export function normalizeCredentialRef(ref: string): string {
  if (ref.startsWith("credential/")) {
    return ref;
  }
  const colonIdx = ref.lastIndexOf(":");
  if (colonIdx < 1 || colonIdx === ref.length - 1) {
    return ref;
  }
  return credentialKey(ref.slice(0, colonIdx), ref.slice(colonIdx + 1));
}
