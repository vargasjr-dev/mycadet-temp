import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  ensureConversationExists,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";

beforeAll(async () => {
  await initializeDb();
});

const { findPersistedSurfaceInfo } =
  await import("../daemon/conversation-surfaces.js");

/** A guardian requester: sees every row, so no provenance filtering applies. */
const GUARDIAN = { requesterCanAccessMemory: true };
/** An untrusted requester: only non-guardian-provenance rows are visible. */
const UNTRUSTED = { requesterCanAccessMemory: false };

// Real rows persist across tests in this file, and several tests pin
// empty-conversation or unknown-surface behavior — give every test its own
// conversation.
let convSeq = 0;
let conversationId: string;

beforeEach(() => {
  conversationId = `conv-persisted-info-${++convSeq}`;
});

/** Seed real message rows (insertion order = read order). */
async function seedRows(
  rows: Array<{ content: unknown[]; metadata?: string }>,
): Promise<void> {
  ensureConversationExists(conversationId, "cadet");
  for (const r of rows) {
    const blocks = [...r.content] as Array<Record<string, unknown>>;
    // Production rows always pair cards with a model-readable sibling (the
    // persistence layer's visibility guard throws otherwise) — declare the
    // same assumption for card-only fixtures.
    if (
      blocks.length > 0 &&
      blocks.every((b) => (b as { type?: unknown }).type === "ui_surface")
    ) {
      blocks.push({
        type: "text",
        text: "[surface]",
        _surfaceFallback: true,
      });
    }
    await addMessage(conversationId, "assistant", JSON.stringify(blocks), {
      ...(r.metadata
        ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> }
        : {}),
    });
  }
}

describe("findPersistedSurfaceInfo", () => {
  test("returns the surfaceType of a persisted ui_surface block", async () => {
    await seedRows([
      {
        content: [
          { type: "text", text: "pick one" },
          {
            type: "ui_surface",
            surfaceId: "surface-choice-1",
            surfaceType: "choice",
            data: { options: [] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-choice-1", GUARDIAN)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("returns the data of a persisted ui_surface block", async () => {
    await seedRows([
      {
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-confirm-1",
            surfaceType: "confirmation",
            data: { message: "Delete it?", confirmLabel: "Delete forever" },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-confirm-1", GUARDIAN)
        ?.data,
    ).toEqual({ message: "Delete it?", confirmLabel: "Delete forever" });
  });

  test("reports no data when the block carries no object data", async () => {
    await seedRows([
      {
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dataless-1",
            surfaceType: "choice",
          },
        ],
      },
    ]);

    const info = findPersistedSurfaceInfo(
      conversationId,
      "surface-dataless-1",
      GUARDIAN,
    );
    expect(info?.surfaceType).toBe("choice");
    expect(info?.data).toBeUndefined();
  });

  test("returns undefined for an unknown surfaceId", async () => {
    await seedRows([
      {
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-choice-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-missing", GUARDIAN),
    ).toBeUndefined();
  });

  test("returns undefined for a conversation with no messages", async () => {
    await seedRows([]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-choice-1", GUARDIAN),
    ).toBeUndefined();
  });

  test("reaches the oldest row when the newer ones carry no surface", async () => {
    await seedRows([
      {
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-oldest-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
      { content: [{ type: "text", text: "later" }] },
      { content: [{ type: "text", text: "later" }] },
      { content: [{ type: "text", text: "later" }] },
    ]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-oldest-1", GUARDIAN)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("reports no surfaceType when the block carries no string one", async () => {
    await seedRows([
      {
        content: [
          { type: "ui_surface", surfaceId: "surface-typeless-1", data: {} },
        ],
      },
    ]);

    const info = findPersistedSurfaceInfo(
      conversationId,
      "surface-typeless-1",
      GUARDIAN,
    );
    expect(info).toBeDefined();
    expect(info?.surfaceType).toBeUndefined();
  });

  test("hides a guardian-provenance row from an untrusted requester", async () => {
    await seedRows([
      {
        metadata: JSON.stringify({ provenanceTrustClass: "guardian" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-guardian-1",
            surfaceType: "confirmation",
            data: { confirmLabel: "Wire the money" },
          },
        ],
      },
    ]);

    // The same row the live history filter drops for this actor.
    expect(
      findPersistedSurfaceInfo(conversationId, "surface-guardian-1", UNTRUSTED),
    ).toBeUndefined();
    expect(
      findPersistedSurfaceInfo(conversationId, "surface-guardian-1", GUARDIAN)
        ?.data,
    ).toEqual({ confirmLabel: "Wire the money" });
  });

  test("hides a provenance-less row from an untrusted requester", async () => {
    await seedRows([
      {
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-unstamped-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(
        conversationId,
        "surface-unstamped-1",
        UNTRUSTED,
      ),
    ).toBeUndefined();
  });

  test("serves a contact-provenance row to an untrusted requester", async () => {
    await seedRows([
      {
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-contact-1",
            surfaceType: "choice",
            data: { options: [] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-contact-1", UNTRUSTED)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("skips a filtered newer row and serves the visible older one", async () => {
    await seedRows([
      {
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dup-1",
            surfaceType: "choice",
            data: { options: [{ id: "visible" }] },
          },
        ],
      },
      {
        metadata: JSON.stringify({ provenanceTrustClass: "guardian" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dup-1",
            surfaceType: "confirmation",
            data: { options: [{ id: "hidden" }] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(conversationId, "surface-dup-1", UNTRUSTED)
        ?.data,
    ).toEqual({ options: [{ id: "visible" }] });
    expect(
      findPersistedSurfaceInfo(conversationId, "surface-dup-1", GUARDIAN)?.data,
    ).toEqual({ options: [{ id: "hidden" }] });
  });
});
