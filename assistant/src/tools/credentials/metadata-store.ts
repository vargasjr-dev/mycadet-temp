/**
 * Credential metadata store.
 *
 * CES owns identity + policy records. This module keeps a synchronous
 * in-process cache so existing call sites stay sync, and always
 * write-throughs to the CES record backend ({@link cesRecordBackend} — a
 * module-level singleton that owns the CES client, including lazy child
 * process sessions).
 *
 * The cache is filled lazily: the first catalog read or write starts a
 * single-flight CES `list()`. Leftover workspace `metadata.json` is not
 * read. CES import (003) may leave that file in place; this module
 * ignores it.
 */

import { randomUUID } from "node:crypto";

import { credentialKey } from "@mycadet/credential-storage";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";

import { createCesHttpRecordBackendIfConfigured } from "../../security/ces-http-record-backend.js";
import {
  cesRecordBackend,
  type CredentialRecordBackend,
} from "../../security/ces-rpc-record-backend.js";
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

function resetCesLoad(): void {
  _cesRecordsLoaded = false;
  _cesLoad = undefined;
  _cesLoadGeneration += 1;
}

// ---------------------------------------------------------------------------
// Production record backend: always the CES RPC singleton
// ---------------------------------------------------------------------------

/**
 * Test-only backend pin. When set, every record operation forwards to it
 * instead of the CES RPC singleton (`undefined` pins a disabled backend —
 * writes stay in-process). Production never calls this; the singleton
 * {@link cesRecordBackend} is always the live backend.
 */
let _testBackendPinned = false;
let _testBackend: CredentialRecordBackend | undefined;

/** @internal Test-only: pin the record backend. `undefined` disables CES. */
export function setCredentialRecordBackend(
  backend: CredentialRecordBackend | undefined,
): void {
  _testBackendPinned = true;
  _testBackend = backend;
  resetCesLoad();
}

function recordBackend(): CredentialRecordBackend | null {
  if (_testBackendPinned) {
    return _testBackend ?? null;
  }
  return cesRecordBackend;
}

async function persistCredentialMetadata(
  metadata: CredentialMetadata,
): Promise<void> {
  const backend = recordBackend();
  if (!backend) {
    return;
  }
  const account = credentialKey(metadata.service, metadata.field);
  const ok = await backend.set(account, toRecord(metadata));
  if (!ok) {
    log.warn(
      { service: metadata.service, field: metadata.field },
      "Failed to persist credential record to CES",
    );
  }
}

let _cesRecordsLoaded = false;
let _cesLoad: Promise<void> | undefined;
let _cesLoadGeneration = 0;

function ensureCesRecordsLoaded(): Promise<void> {
  if (recordBackend() === null || _cesRecordsLoaded) {
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
    const backend = recordBackend();
    if (!backend || generation !== _cesLoadGeneration) {
      return;
    }
    // No sync availability pre-gate: the backend owns its CES session and
    // connects lazily on the first list(). A failed list keeps the
    // in-process cache (an outage must not look like an empty vault).
    const remote = await backend.list();
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

type ListedCredentialRecords = Array<{
  account: string;
  record: CredentialRecord;
}>;

async function listFromRecordBackend(
  backend: CredentialRecordBackend,
): Promise<ListedCredentialRecords | null> {
  return backend.list();
}

function resolveHttpRecordBackend(): CredentialRecordBackend | null {
  if (_httpRecordBackendOverride !== undefined) {
    return _httpRecordBackendOverride;
  }
  return createCesHttpRecordBackendIfConfigured();
}

async function listFromHttpFallback(): Promise<ListedCredentialRecords | null> {
  const httpBackend = resolveHttpRecordBackend();
  if (!httpBackend) {
    return null;
  }
  return listFromRecordBackend(httpBackend);
}

/**
 * Test override for the CES HTTP listing fallback. `undefined` uses the
 * production factory. `null` disables HTTP fallback.
 */
let _httpRecordBackendOverride: CredentialRecordBackend | null | undefined;

/** @internal Test-only: override the CES HTTP listing fallback. */
export function _setHttpRecordBackendForTests(
  backend: CredentialRecordBackend | null | undefined,
): void {
  _httpRecordBackendOverride = backend;
}

/**
 * Live catalog from the credential record backend. Does not read the
 * daemon in-process cache, so an outage cannot be mistaken for an empty
 * vault. `unreachable` is true when the backend is down, or the list RPC
 * fails, and CES HTTP failover is also unavailable.
 *
 * When the attached backend is CES RPC (the singleton), listing fails over
 * to CES HTTP in containerized deployments so a down RPC socket does not
 * hide a healthy vault sidecar. A successful empty catalog (`[]`) does not
 * fall through to HTTP.
 */
export async function listCredentialRecordsLive(): Promise<CredentialRecordListResult> {
  const backend = recordBackend();
  if (backend) {
    const remote = await listFromRecordBackend(backend);
    if (remote !== null) {
      return {
        records: remote.map((entry) => entry.record as CredentialMetadata),
        unreachable: false,
      };
    }
    if (backend.name !== "ces-rpc") {
      return { records: [], unreachable: true };
    }
  }
  const httpRemote = await listFromHttpFallback();
  if (httpRemote !== null) {
    log.warn(
      "CES RPC credential record list unavailable. Failing over to CES HTTP.",
    );
    return {
      records: httpRemote.map((entry) => entry.record as CredentialMetadata),
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
  const backend = recordBackend();
  if (deleted && backend) {
    void backend.delete(credentialKey(service, field));
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
