/**
 * Unknown-method escalation on the typed contacts mirror ops.
 *
 * An old daemon rejects `contacts_mirror_merge_contact` /
 * `contacts_mirror_upsert_full` with "Unknown method"; the best-effort catch
 * must NOT swallow that silently — it escalates through the mirror-op-missing
 * reporter (error log + `contacts_mirror_op_missing` watchdog telemetry)
 * while the gateway write still stands (no raw-SQL fallback by design). Any
 * other IPC failure keeps the routine best-effort warn: no escalation, same
 * gateway state.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";

import "./test-preload.js";

// ── Mocked daemon IPC (leak-safe: delegates to a mutable mock, spreads the
// actual module so other exports stay importable across suites) ─────────────

type IpcCallFn = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

const ipcCalls: string[] = [];
// Method name → error to throw whenever it is called.
const ipcThrowOn = new Map<string, Error>();

let ipcCallAssistantMock: ReturnType<typeof mock<IpcCallFn>> = mock(
  async () => ({}),
);

const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: (...args: Parameters<IpcCallFn>) =>
    ipcCallAssistantMock(...args),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";
import * as mirrorOpReporter from "../contacts-mirror-op-reporter.js";

// ── Setup ────────────────────────────────────────────────────────────────────

// The reporter's report fns carry the detail payload; capture them by
// re-registering the reporter module with a recorder (its real sibling
// exports — the unknown-method classifier — stay live for the store).
const reportCalls: { op: string; detail: Record<string, unknown> }[] = [];

mock.module("../contacts-mirror-op-reporter.js", () => ({
  ...mirrorOpReporter,
  reportMirrorOpMissing: (op: string, detail: Record<string, unknown>) => {
    reportCalls.push({ op, detail });
  },
}));

// The SUT must load AFTER the mock registrations above — a static import
// would bind contact-store to the REAL ipc client + reporter before either
// mock.module runs (bun mock.module is not retroactive for modules already
// imported), and the escalations would never reach the recorder.
const { ContactStore } = await import("../db/contact-store.js");

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();

  ipcCalls.length = 0;
  ipcThrowOn.clear();
  ipcCallAssistantMock = mock(async (method: string) => {
    ipcCalls.push(method);
    const err = ipcThrowOn.get(method);
    if (err) throw err;
    if (method === "contacts_info_batch") return { infos: [] };
    if (method === "contact_user_file_slugs") return { userFiles: [] };
    return {};
  });

  reportCalls.length = 0;
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string) {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `name-${id}`,
      role: "contact",
      principalId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(id: string, contactId: string) {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id,
      contactId,
      type: "slack" as never,
      address: `addr-${id}`,
      isPrimary: false,
      status: "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function unknownMethodError(method: string): Error {
  // Exact shape the daemon IPC server sends for an unregistered method,
  // surfaced by ipcCallAssistant as a transport-level Error message.
  return new Error(`Unknown method: ${method}`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("mergeContacts — unknown mirror op escalation", () => {
  test("unknown method → fail-loud report; gateway merge still applied", async () => {
    seedContact("ct_keep");
    seedContact("ct_merge");
    seedChannel("ch_1", "ct_merge");
    ipcThrowOn.set(
      "contacts_mirror_merge_contact",
      unknownMethodError("contacts_mirror_merge_contact"),
    );

    const store = new ContactStore();
    const { contact, mirrored } = await store.mergeContacts(
      "ct_keep",
      "ct_merge",
    );

    // Gateway (source of truth) merge stands: donor gone, channel moved.
    expect(contact!.id).toBe("ct_keep");
    expect(mirrored).toBe(false);
    const db = getGatewayDb();
    expect(
      db
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === "ct_merge"),
    ).toBeUndefined();
    expect(
      db
        .select()
        .from(contactChannels)
        .all()
        .find((c) => c.id === "ch_1")?.contactId,
    ).toBe("ct_keep");

    // Escalated: exactly one fail-loud report with the op + detail.
    expect(reportCalls).toEqual([
      {
        op: "contacts_mirror_merge_contact",
        detail: { keepId: "ct_keep", mergeId: "ct_merge" },
      },
    ]);
  });

  test("other IPC failure → no report, same gateway state", async () => {
    seedContact("ct_keep");
    seedContact("ct_merge");
    seedChannel("ch_1", "ct_merge");
    ipcThrowOn.set(
      "contacts_mirror_merge_contact",
      new Error("daemon unavailable"),
    );

    const store = new ContactStore();
    const { contact, mirrored } = await store.mergeContacts(
      "ct_keep",
      "ct_merge",
    );

    expect(contact!.id).toBe("ct_keep");
    expect(mirrored).toBe(false);
    expect(
      getGatewayDb()
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === "ct_merge"),
    ).toBeUndefined();

    // No escalation: the report never fires.
    expect(reportCalls).toEqual([]);
  });
});

describe("upsertContact — unknown mirror op escalation", () => {
  test("unknown method → fail-loud report; gateway upsert still applied", async () => {
    ipcThrowOn.set(
      "contacts_mirror_upsert_full",
      unknownMethodError("contacts_mirror_upsert_full"),
    );

    const store = new ContactStore();
    const { contact, created } = await store.upsertContact({
      displayName: "Alice",
      channels: [{ type: "slack", address: "U12345" }],
    });

    // Gateway write stands.
    expect(created).toBe(true);
    expect(
      getGatewayDb()
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === contact.id),
    ).toBeDefined();
    expect(store.getChannelsForContact(contact.id)).toHaveLength(1);

    expect(reportCalls).toEqual([
      {
        op: "contacts_mirror_upsert_full",
        detail: { contactId: contact.id },
      },
    ]);
  });

  test("other IPC failure → no report, same gateway state", async () => {
    ipcThrowOn.set("contacts_mirror_upsert_full", new Error("socket closed"));

    const store = new ContactStore();
    const { contact, created } = await store.upsertContact({
      displayName: "Bob",
      channels: [{ type: "slack", address: "U67890" }],
    });

    expect(created).toBe(true);
    expect(store.getChannelsForContact(contact.id)).toHaveLength(1);
    expect(reportCalls).toEqual([]);
  });
});
