/**
 * Credential metadata store: an in-process cache write-through to the CES
 * record backend.
 */

import { randomUUID } from "node:crypto";

import { credentialKey } from "@mycadet/credential-storage";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";

import { cesRecordBackend } from "../../security/ces-rpc-record-backend.js";
import { getLogger } from "../../util/logger.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

const log = getLogger("credential-metadata-store");

/**
 * CredentialMetadata extends the shared StaticCredentialRecord with
 * assistant-specific injection template fields (composeWith, valueTransform).
 * Structurally compatible - the shared store persists all fields as-is.
 */
export interface CredentialMetadata {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  usageDescription?: string;
  /** Human-friendly name for this credential (e.g. "fal-primary"). */
  alias?: string;
  /** Templates describing how to inject this credential into proxied requests. */
  injectionTemplates?: CredentialInjectionTemplate[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

/**
 * The assistant-side metadata cache. All durable state lives in CES; this
 * cache exists purely so the historical synchronous call sites keep working.
 * It starts empty and is filled by the single-flight CES load.
 */
class MetadataCache {
  private records: CredentialMetadata[] = [];

  useMemory(records: CredentialMetadata[]): void {
    this.records = records.map((record) => ({ ...record }));
  }

  /** No-op: the in-process cache is always writable. */
  assertWritable(): void {}

  upsert(
    service: string,
    field: string,
    policy?: {
      allowedTools?: string[];
      allowedDomains?: string[];
      usageDescription?: string;
      alias?: string | null;
      injectionTemplates?: CredentialInjectionTemplate[] | null;
    },
  ): CredentialMetadata {
    const now = Date.now();
    const existing = this.records.find(
      (r) => r.service === service && r.field === field,
    );
    if (existing) {
      if (policy?.allowedTools !== undefined) {
        existing.allowedTools = policy.allowedTools;
      }
      if (policy?.allowedDomains !== undefined) {
        existing.allowedDomains = policy.allowedDomains;
      }
      if (policy?.usageDescription !== undefined) {
        existing.usageDescription = policy.usageDescription;
      }
      if (policy?.alias !== undefined) {
        if (policy.alias == null) {
          delete existing.alias;
        } else {
          existing.alias = policy.alias;
        }
      }
      if (policy?.injectionTemplates !== undefined) {
        if (policy.injectionTemplates == null) {
          delete existing.injectionTemplates;
        } else {
          existing.injectionTemplates = policy.injectionTemplates;
        }
      }
      existing.updatedAt = now;
      return existing;
    }
    const record: CredentialMetadata = {
      credentialId: randomUUID(),
      service,
      field,
      allowedTools: policy?.allowedTools ?? [],
      allowedDomains: policy?.allowedDomains ?? [],
      usageDescription: policy?.usageDescription,
      alias: policy?.alias ?? undefined,
      injectionTemplates: policy?.injectionTemplates ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    return record;
  }

  getByServiceField(
    service: string,
    field: string,
  ): CredentialMetadata | undefined {
    return this.records.find((r) => r.service === service && r.field === field);
  }

  getById(credentialId: string): CredentialMetadata | undefined {
    return this.records.find((r) => r.credentialId === credentialId);
  }

  list(): CredentialMetadata[] {
    return this.records;
  }

  delete(service: string, field: string): boolean {
    const idx = this.records.findIndex(
      (r) => r.service === service && r.field === field,
    );
    if (idx === -1) {
      return false;
    }
    this.records.splice(idx, 1);
    return true;
  }
}

const _store = new MetadataCache();

function toRecord(metadata: CredentialMetadata): CredentialRecord {
  return {
    credentialId: metadata.credentialId,
    service: metadata.service,
    field: metadata.field,
    allowedTools: metadata.allowedTools,
    allowedDomains: metadata.allowedDomains,
    usageDescription: metadata.usageDescription,
    alias: metadata.alias,
    injectionTemplates: metadata.injectionTemplates,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Production record backend: always the CES RPC singleton
// ---------------------------------------------------------------------------

/**
 * Raised when the credential catalog (the CES record backend) cannot be
 * written. Callers surface it as a 5xx: CES is expected to be up and
 * reachable once the assistant reports ready, so the CLI owns any retry.
 */
export class CredentialCatalogUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "CredentialCatalogUnavailableError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

let _cesRecordsLoaded = false;
let _cesLoad: Promise<void> | undefined;
let _cesLoadGeneration = 0;

function resetCesLoad(): void {
  _cesRecordsLoaded = false;
  _cesLoad = undefined;
  _cesLoadGeneration += 1;
}

function ensureCesRecordsLoaded(): Promise<void> {
  if (_cesRecordsLoaded) {
    return Promise.resolve();
  }
  if (_cesLoad) {
    return _cesLoad;
  }
  const generation = _cesLoadGeneration;
  _cesLoad = loadCesRecords(generation).finally(() => {
    if (_cesLoadGeneration === generation) {
      _cesLoad = undefined;
    }
  });
  return _cesLoad;
}

async function loadCesRecords(generation: number): Promise<void> {
  try {
    if (generation !== _cesLoadGeneration) {
      return;
    }
    // The backend owns its CES session and connects lazily on the first
    // list(). A failed list keeps the in-process cache (an outage must not
    // look like an empty vault).
    const remote = await cesRecordBackend.list();
    if (generation !== _cesLoadGeneration) {
      return;
    }
    if (remote === null) {
      log.warn("CES record list failed; keeping in-process cache");
      return;
    }

    const localByAccount = new Map(
      _store
        .list()
        .map((record) => [credentialKey(record.service, record.field), record]),
    );
    const merged = remote.map((entry) => {
      const local = localByAccount.get(entry.account);
      if (local) {
        localByAccount.delete(entry.account);
        return local;
      }
      return entry.record;
    });
    for (const leftover of localByAccount.values()) {
      merged.push(leftover);
    }
    _store.useMemory(merged);
    _cesRecordsLoaded = true;
    log.info({ count: remote.length }, "Loaded credential records from CES");
  } catch (err) {
    log.warn({ err }, "CES record load failed");
  }
}

function touchCesCache(): void {
  void ensureCesRecordsLoaded();
}

// ---------------------------------------------------------------------------
// Public API - unchanged signatures, backed by cache + CES write-through
// ---------------------------------------------------------------------------

/**
 * Throws if the metadata store cannot be safely mutated.
 * Call this before performing irreversible credential store operations
 * so the operation fails cleanly before any side effects.
 */
export function assertMetadataWritable(): void {
  touchCesCache();
  _store.assertWritable();
}

/**
 * Create or update a credential metadata record.
 * If a record with the same service+field exists, it is updated.
 * The upsert is awaited through to CES: the record is not "set" until the
 * catalog write lands, and a CES outage raises
 * {@link CredentialCatalogUnavailableError} so the caller can return a 5xx
 * (the CLI owns retries).
 *
 * @throws {CredentialCatalogUnavailableError} when CES is unreachable or
 *   rejects the write.
 */
export async function upsertCredentialMetadata(
  service: string,
  field: string,
  policy?: {
    allowedTools?: string[];
    allowedDomains?: string[];
    usageDescription?: string;
    /** Pass `null` to explicitly clear a previously-set alias. */
    alias?: string | null;
    /** Pass `null` to explicitly clear injection templates. */
    injectionTemplates?: CredentialInjectionTemplate[] | null;
  },
): Promise<CredentialMetadata> {
  touchCesCache();
  const record = _store.upsert(service, field, policy);
  const account = credentialKey(service, field);
  try {
    const ok = await cesRecordBackend.set(account, toRecord(record));
    if (!ok) {
      throw new CredentialCatalogUnavailableError(
        `CES rejected the credential record write for ${service}:${field}`,
      );
    }
  } catch (err) {
    if (err instanceof CredentialCatalogUnavailableError) {
      throw err;
    }
    throw new CredentialCatalogUnavailableError(
      `Failed to persist the credential record for ${service}:${field} — the credential catalog (CES) is unreachable`,
      { cause: err },
    );
  }
  return record;
}

/**
 * Get metadata for a credential by service and field.
 */
export function getCredentialMetadata(
  service: string,
  field: string,
): CredentialMetadata | undefined {
  touchCesCache();
  return _store.getByServiceField(service, field);
}

/**
 * Get metadata for a credential by its opaque ID.
 */
export function getCredentialMetadataById(
  credentialId: string,
): CredentialMetadata | undefined {
  touchCesCache();
  return _store.getById(credentialId);
}

/**
 * List all credential metadata records.
 */
export function listCredentialMetadata(): CredentialMetadata[] {
  touchCesCache();
  return _store.list();
}

export type CredentialRecordListResult = {
  records: CredentialMetadata[];
  unreachable: boolean;
};

/**
 * Live catalog from the credential record backend. Does not read the
 * daemon in-process cache, so an outage cannot be mistaken for an empty
 * vault. `unreachable` is true when the backend is down or the list RPC
 * fails.
 */
export async function listCredentialRecordsLive(): Promise<CredentialRecordListResult> {
  const remote = await cesRecordBackend.list();
  if (remote !== null) {
    return {
      records: remote.map((entry) => entry.record as CredentialMetadata),
      unreachable: false,
    };
  }
  return { records: [], unreachable: true };
}

/**
 * Delete metadata for a credential. The deletion is awaited through to CES:
 * a CES outage raises {@link CredentialCatalogUnavailableError} so the
 * caller can return a 5xx instead of losing the delete silently.
 */
export async function deleteCredentialMetadata(
  service: string,
  field: string,
): Promise<boolean> {
  touchCesCache();
  const deleted = _store.delete(service, field);
  if (deleted) {
    try {
      await cesRecordBackend.delete(credentialKey(service, field));
    } catch (err) {
      throw new CredentialCatalogUnavailableError(
        `Failed to delete the credential record for ${service}:${field} — the credential catalog (CES) is unreachable`,
        { cause: err },
      );
    }
  }
  return deleted;
}

/** @internal Test-only: wait for the in-flight CES list to populate the cache. */
export function _ensureCesRecordsLoaded(): Promise<void> {
  return ensureCesRecordsLoaded();
}

/** @internal Test-only: drop the in-process cache and CES load state. */
export function _resetCredentialMetadataCacheForTests(): void {
  _store.useMemory([]);
  resetCesLoad();
}
