/**
 * CredentialBackend interface and adapters — abstracts credential storage
 * behind a unified async API so callers don't need to know which backend
 * is in use.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a delete operation — distinguishes success, not-found, and error. */
export type DeleteResult = "deleted" | "not-found" | "error";

/** Result of a get operation — distinguishes unreachable from not-found. */
export interface CredentialGetResult {
  value: string | undefined;
  unreachable: boolean;
}

/** Result of a list operation — distinguishes unreachable from empty. */
export interface CredentialListResult {
  accounts: string[];
  unreachable: boolean;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CredentialBackend {
  /** Human-readable name for logging (e.g. "encrypted-store"). */
  readonly name: string;

  /** Whether this backend is currently reachable. Sync and cheap. */
  isAvailable(): boolean;

  /** Retrieve a secret. Returns a result distinguishing unreachable from not-found. */
  get(account: string): Promise<CredentialGetResult>;

  /** Store a secret. Returns true on success. */
  set(account: string, value: string): Promise<boolean>;

  /** Delete a secret. */
  delete(account: string): Promise<DeleteResult>;

  /** List all account names. */
  list(): Promise<CredentialListResult>;

  /** Bulk-set multiple credentials. Optional — backends without native bulk support omit this. */
  bulkSet?(
    credentials: Array<{ account: string; value: string }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;
}

// ---------------------------------------------------------------------------
// UnavailableBackend
// ---------------------------------------------------------------------------

/**
 * A backend whose every operation reports the store as unreachable. Used on
 * containerized pods when no CES path is ready: resolving to the (nonexistent)
 * local encrypted store would report provisioned credentials as absent, but
 * the correct state is "temporarily unreachable" (presence indeterminate),
 * which callers retry rather than treating as a missing key.
 */
class UnavailableBackend implements CredentialBackend {
  readonly name = "unavailable";

  isAvailable(): boolean {
    return false;
  }

  async get(): Promise<CredentialGetResult> {
    return { value: undefined, unreachable: true };
  }

  async set(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<DeleteResult> {
    return "error";
  }

  async list(): Promise<CredentialListResult> {
    return { accounts: [], unreachable: true };
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createUnavailableBackend(): UnavailableBackend {
  return new UnavailableBackend();
}
