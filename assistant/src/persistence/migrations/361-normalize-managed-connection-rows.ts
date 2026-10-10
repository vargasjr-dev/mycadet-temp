import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const CADET_PROVIDER = "cadet";
const PLATFORM_AUTH_JSON = JSON.stringify({ type: "platform" });

/**
 * Reconcile `provider_connections` rows so platform auth and provider
 * "cadet" always pair. The two columns record the same fact (the cloud,
 * platform-billed route); auth derivation sets them together and the
 * connection routes reject writes that split them, but rows written before
 * that guard can disagree. The provider column is the authoritative managed
 * signal (`isCadetCloudConnection`), so mismatched rows must converge:
 *
 * - Platform auth with any other provider: the provider becomes "cadet".
 *   These rows dispatch through the cloud proxy (transport selection keys
 *   on the cloud identity), so normalizing the provider preserves billing
 *   and transport behavior, while normalizing the auth instead would
 *   silently turn a cloud-billed row into a keyless BYOK row. This also
 *   heals a stuck pre-consolidation canonical row (name "cadet", concrete
 *   provider, platform auth) that boot seeding skips because its provider
 *   differs from the sentinel.
 * - Provider "cadet" with any other auth: the auth becomes
 *   `{"type":"platform"}`. A cadet row means the cloud route by
 *   definition, and non-cloud auth on it never yields a usable adapter.
 *
 * Rows whose auth column is not valid JSON are left alone (the DB loaders
 * already treat them as invalid). Idempotent: a reconciled row matches
 * neither rule, and the table-exists guard covers databases from before
 * migration 243.
 */
export function migrateNormalizeManagedConnectionRows(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
    )
    .get();
  if (!tableExists) {
    return;
  }

  const rows = raw
    .query(`SELECT name, provider, auth FROM provider_connections`)
    .all() as Array<{ name: string; provider: string; auth: string }>;

  const now = Date.now();
  for (const row of rows) {
    let authType: unknown;
    try {
      const parsed: unknown = JSON.parse(row.auth);
      authType =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { type?: unknown }).type
          : undefined;
    } catch {
      continue;
    }

    if (authType === "platform" && row.provider !== CADET_PROVIDER) {
      raw
        .prepare(
          `UPDATE provider_connections SET provider = ?, updated_at = ? WHERE name = ?`,
        )
        .run(CADET_PROVIDER, now, row.name);
    } else if (row.provider === CADET_PROVIDER && authType !== "platform") {
      raw
        .prepare(
          `UPDATE provider_connections SET auth = ?, updated_at = ? WHERE name = ?`,
        )
        .run(PLATFORM_AUTH_JSON, now, row.name);
    }
  }
}
