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

/** Retry backoff for a failed record write (the hatch set races CES boot). */
const PERSIST_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];

/**
 * Records whose CES write failed, keyed by account. Re-flushed on the next
 * successful CES load so a set that raced CES startup is not lost — the
 * vault holds the secret but the catalog record is what every listing reads.
 */
const pendingPersists = new Map<string, CredentialMetadata>();

let persistFlushScheduled = false;

function schedulePendingFlush(): void {
  if (persistFlushScheduled) {
    return;
  }
  persistFlushScheduled = true;
  const delay = PERSIST_RETRY_DELAYS_MS[0]!;
  setTimeout(() => {
    persistFlushScheduled = false;
    void flushPendingPersists(0);
  }, delay).unref?.();
}

async function flushPendingPersists(attempt: number): Promise<void> {
  if (pendingPersists.size === 0) {
    return;
  }
  const batch = [...pendingPersists.values()];
  for (const metadata of batch) {
    const account = credentialKey(metadata.service, metadata.field);
    const ok = await cesRecordBackend.set(account, toRecord(metadata));
    if (ok) {
      pendingPersists.delete(account);
    }
  }
  if (pendingPersists.size > 0 && attempt < PERSIST_RETRY_DELAYS_MS.length - 1) {
    const delay = PERSIST_RETRY_DELAYS_MS[attempt + 1]!;
    setTimeout(() => {
      void flushPendingPersists(attempt + 1);
    }, delay).unref?.();
  }
}

async function persistCredentialMetadata(
  metadata: CredentialMetadata,
): Promise<void> {
  const account = credentialKey(metadata.service, metadata.field);
  const ok = await cesRecordBackend.set(account, toRecord(metadata));
  if (ok) {
    pendingPersists.delete(account);
    return;
  }
  log.warn(
    { service: metadata.service, field: metadata.field },
    "Failed to persist credential record to CES; queued for retry",
  );
  pendingPersists.set(account, metadata);
  schedulePendingFlush();
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

    // Durability: a write that raced CES startup (initial hatch) or a restart
    // before the write-through landed leaves the vault holding a secret with
    // no catalog record. Re-persist anything the CES catalog is missing.
    void reconcileMissingRecords(merged);
  } catch (err) {
    log.warn({ err }, "CES record load failed");
  }
}

/**
 * Push catalog records for vault-backed credentials that CES does not know
 * about, so a hatch-time write lost to a CES race self-heals (including
 * across assistant restarts — the vault enumerates its accounts).
 */
function parseVaultAccount(
  account: string,
): { service: string; field: string } | undefined {
  const prefix = "credential/";
  if (!account.startsWith(prefix)) {
    return undefined;
  }
  const rest = account.slice(prefix.length);
  const slashIdx = rest.lastIndexOf("/");
  if (slashIdx < 1 || slashIdx === rest.length - 1) {
    return undefined;
  }
  return { service: rest.slice(0, slashIdx), field: rest.slice(slashIdx + 1) };
}

async function reconcileMissingRecords(records: CredentialMetadata[]): Promise<void> {
  try {
    const knownAccounts = new Set(
      records.map((record) => credentialKey(record.service, record.field)),
    );
    const { listSecureKeysAsync } = await import("../../security/secure-keys.js");
    const vault = await listSecureKeysAsync();
    if (!vault.unreachable) {
      for (const account of vault.accounts) {
        if (knownAccounts.has(account)) {
          continue;
        }
        const parsed = parseVaultAccount(account);
        if (!parsed) {
          continue;
        }
        const now = Date.now();
        const record: CredentialMetadata = {
          credentialId: randomUUID(),
          service: parsed.service,
          field: parsed.field,
          allowedTools: [],
          allowedDomains: [],
          createdAt: now,
          updatedAt: now,
        };
        _store.upsert(parsed.service, parsed.field);
        pendingPersists.set(account, record);
      }
      if (pendingPersists.size > 0) {
        log.info(
          { count: pendingPersists.size },
          "Reconciling vault credentials missing from the CES catalog",
        );
        void flushPendingPersists(0);
      }
    }
  } catch (err) {
    log.warn({ err }, "Vault-to-CES record reconciliation failed");
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
 * The upsert also write-throughs to CES via the record backend.
 */
export function upsertCredentialMetadata(
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
): CredentialMetadata {
  touchCesCache();
  const record = _store.upsert(service, field, policy);
  void persistCredentialMetadata(record);
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
 * Delete metadata for a credential.
 */
export function deleteCredentialMetadata(
  service: string,
  field: string,
): boolean {
  touchCesCache();
  const deleted = _store.delete(service, field);
  if (deleted) {
    void cesRecordBackend.delete(credentialKey(service, field));
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
