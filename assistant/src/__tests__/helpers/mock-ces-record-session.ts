/**
 * Request-mock for the CES RPC session.
 *
 * The production record backend owns its CES session (opened lazily via
 * `openCesRpcSession`). Tests mock that session boundary and put the fake
 * RPC client's `call` dispatcher in control of an in-memory record store —
 * the same request-level mock shape the HTTP-side tests use with fetch.
 * Install BEFORE importing anything that reaches `cesRecordBackend`.
 */
import { mock } from "bun:test";

import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";
import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";

export interface MockCesRecordSession {
  /** In-memory record store backing the fake RPC handlers. */
  store: Map<string, CredentialRecord>;
  /** Every RPC request that reached the fake client, in order. */
  calls: Array<{ method: CesRpcMethod; request: unknown }>;
  /** Make the next `openCesRpcSession` fail (CES unreachable). */
  failSession: boolean;
  /** Make every set RPC report failure. */
  failSet: boolean;
  /** Make every list RPC report an outage (`null`). */
  failList: boolean;
  /** Flip the fake transport's readiness. */
  setClientReady: (ready: boolean) => void;
}

export function installMockCesRecordSession(): MockCesRecordSession {
  const store = new Map<string, CredentialRecord>();
  const calls: Array<{ method: CesRpcMethod; request: unknown }> = [];
  const state: {
    failSession: boolean;
    failSet: boolean;
    failList: boolean;
    clientReady: boolean;
  } = { failSession: false, failSet: false, failList: false, clientReady: true };

  const client = {
    handshake: async () => ({ accepted: true }),
    call: async (
      method: CesRpcMethod,
      request: unknown,
    ): Promise<unknown> => {
      calls.push({ method, request });
      const req = request as {
        account?: string;
        record?: CredentialRecord;
        records?: Array<{ account: string; record: CredentialRecord }>;
      };
      switch (method) {
        case CesRpcMethod.GetCredentialRecord: {
          const record = req.account ? store.get(req.account) : undefined;
          return record
            ? { found: true, record }
            : { found: false, record: undefined };
        }
        case CesRpcMethod.SetCredentialRecord: {
          if (state.failSet || !req.account || !req.record) {
            return { ok: false };
          }
          store.set(req.account, req.record);
          return { ok: true };
        }
        case CesRpcMethod.DeleteCredentialRecord: {
          if (!req.account || !store.has(req.account)) {
            return { result: "not-found" };
          }
          store.delete(req.account);
          return { result: "deleted" };
        }
        case CesRpcMethod.ListCredentialRecords: {
          if (state.failList) {
            throw new Error("CES list transport failed");
          }
          return {
            records: [...store.entries()].map(([account, record]) => ({
              account,
              record,
            })),
          };
        }
        case CesRpcMethod.BulkSetCredentialRecords: {
          const results = (req.records ?? []).map(
            (entry: { account: string; record: CredentialRecord }) => {
              if (state.failSet) {
                return { account: entry.account, ok: false };
              }
              store.set(entry.account, entry.record);
              return { account: entry.account, ok: true };
            },
          );
          return { results };
        }
        default:
          return {};
      }
    },
    isReady: () => state.clientReady,
    close: () => {
      state.clientReady = false;
    },
    updateAssistantApiKey: async () => ({ updated: true }),
  } as never;

  const fakeSession = {
    client,
    processManager: {
      start: async () => ({}),
      stop: async () => {},
      forceStop: async () => {},
      onTransportClose: () => {},
    },
  };

  mock.module("../../credential-execution/ces-connect.js", () => ({
    openCesRpcSession: async () => (state.failSession ? undefined : fakeSession),
    reconnectCesRpcSession: async () => client,
  }));

  return {
    store,
    calls,
    get failSession() {
      return state.failSession;
    },
    set failSession(v: boolean) {
      state.failSession = v;
    },
    get failSet() {
      return state.failSet;
    },
    set failSet(v: boolean) {
      state.failSet = v;
    },
    get failList() {
      return state.failList;
    },
    set failList(v: boolean) {
      state.failList = v;
    },
    setClientReady: (ready: boolean) => {
      state.clientReady = ready;
    },
  };
}
