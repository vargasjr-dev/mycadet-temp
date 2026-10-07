/**
 * Verifies how `persistQueuedMessageBody` resolves the `scripted` marker onto
 * `messages.metadata.scripted`, which `turn-events-store` forwards to
 * `TurnTelemetryEvent.scripted`.
 *
 * `scripted` is what lets activation metrics exclude auto-sent onboarding
 * turns for EVERY owner, rather than only those who opted into diagnostics
 * (ANT-10). Its contract is three-state and the states are not
 * interchangeable:
 *
 *   true    - auto-sent on the user's behalf
 *   false   - a genuine typed user message
 *   absent  - UNKNOWN
 *
 * The absent case is the one worth protecting: downstream falls back to the
 * legacy trace-text classifier when the flag is missing, but TRUSTS an
 * explicit `false`. So a spurious `false` is strictly worse than no value:
 * it re-inflates activation past the point where the fallback can catch it.
 *
 * Mirrors the mock harness of `client-os-metadata-persistence.test.ts`:
 * exercises `persistQueuedMessageBody` directly with a captured `addMessage`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  ensureConversationExists,
  getMessages,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";

beforeAll(async () => {
  await initializeDb();
});

// Real rows persist across tests in a file — give every test its own
// conversation so "the last persisted row" is unambiguous.
let convSeq = 0;
let conversationId: string;

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import type { MessageQueue } from "../daemon/conversation-queue-manager.js";
import type { TrustContext } from "../daemon/trust-context-types.js";

function createContext(): MessagingConversationContext {
  const channel: TurnChannelContext = {
    userMessageChannel: "cadet",
    assistantMessageChannel: "cadet",
  };
  const iface: TurnInterfaceContext = {
    userMessageInterface: "web",
    assistantMessageInterface: "web",
  };
  const queueStub = {
    push: () => true,
    drain: () => [],
    size: () => 0,
  } as unknown as MessageQueue;
  let processing = false;
  let owner = 0;
  return {
    conversationId,
    messages: [],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    acquireProcessingFenced: async () => {
      if (processing) {
        return null;
      }
      processing = true;
      owner += 1;
      return owner;
    },
    releaseProcessing: (claim: number) => {
      if (claim !== owner) {
        return false;
      }
      processing = false;
      return true;
    },
    abortController: null,
    queue: queueStub,
    clientOs: undefined,
    getTurnChannelContext: () => channel,
    getTurnInterfaceContext: () => iface,
  };
}

function lastUserMetadata(): Record<string, unknown> {
  const rows = getMessages(conversationId);
  expect(rows.length).toBeGreaterThan(0);
  const metadata = rows.at(-1)!.metadata;
  expect(metadata).not.toBeNull();
  return JSON.parse(metadata!) as Record<string, unknown>;
}

describe("scripted-turn metadata persistence", () => {
  beforeEach(() => {
    conversationId = `conv-scripted-${++convSeq}`;
    ensureConversationExists(conversationId, "cadet");
  });

  test("stamps the typed option", async () => {
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "[User action on choice surface: Work]",
      requestId: "req-option-true",
      scripted: true,
    });

    expect(lastUserMetadata().scripted).toBe(true);
  });

  test("carries the flag through the metadata bag for queued sends", async () => {
    // The queue round-trips `metadata` but not `PersistMessageOptions`, so a
    // surface action that was enqueued while a turn was in flight can only
    // deliver its marker this way. If this regresses, queued surface actions
    // silently become "unknown" while direct ones stay marked.
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "[User action on app: Answer Selected]",
      requestId: "req-metadata-true",
      metadata: { scripted: true },
    });

    expect(lastUserMetadata().scripted).toBe(true);
  });

  test("treats `automated` as implying scripted", async () => {
    // Machine-authored by definition, so it is not a turn the user typed.
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "automated skill message",
      requestId: "req-automated",
      metadata: { automated: true },
    });

    expect(lastUserMetadata().scripted).toBe(true);
  });

  test("lets an explicit option override the automated default", async () => {
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "automated but counts as a real turn",
      requestId: "req-automated-override",
      metadata: { automated: true },
      scripted: false,
    });

    expect(lastUserMetadata().scripted).toBe(false);
  });

  test("defaults an ordinary send to false, asserting a typed turn", async () => {
    // The default is what makes activation MEASURABLE: absent would mean
    // "unknown", which is strictly worse information than a truthful false.
    // Safe only because every auto-send path is marked at its source (web
    // onboarding flows, surface synthetics, `automated`).
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "a message the user actually typed",
      requestId: "req-ordinary",
    });

    expect(lastUserMetadata().scripted).toBe(false);
  });

  test("falls back to the default for a non-boolean `scripted` in the bag", async () => {
    // Guards against a truthy string ("true", "1") from an untyped caller
    // being read as a scripted assertion. It must not survive the metadata
    // spread either: sqlite would store the string verbatim and the store's
    // narrowing turns anything that isn't 1 into `false`, so a leaked "true"
    // would invert into "the user typed this".
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-bogus",
      metadata: { scripted: "true" },
    });

    expect(lastUserMetadata().scripted).toBe(false);
  });

  test("stamps false when the caller explicitly asserts a typed turn", async () => {
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "hello",
      requestId: "req-explicit-false",
      scripted: false,
    });

    expect(lastUserMetadata().scripted).toBe(false);
  });
});

describe("author contact id on a persisted user message", () => {
  const sender: TrustContext = {
    sourceChannel: "slack",
    trustClass: "trusted_contact",
    requesterContactId: "contact-alice",
  };

  beforeEach(() => {
    conversationId = `conv-scripted-${++convSeq}`;
    ensureConversationExists(conversationId, "cadet");
  });

  test("a message relayed from the sender names them as its author", async () => {
    await persistQueuedMessageBody(createContext(), {
      content: "the export endpoint needs a scoped token",
      requestId: "req-author-typed",
      trustContext: sender,
      author: sender,
    });

    expect(lastUserMetadata().provenanceContactId).toBe("contact-alice");
  });

  test("a row persisted under the sender's trust but not relayed from them names no author", async () => {
    // Machine-authored rows (ACP and subagent notifications, pointer turns)
    // share this writer and the conversation's trust; only an explicit
    // author names one.
    await persistQueuedMessageBody(createContext(), {
      content: "the delegated task finished",
      requestId: "req-author-machine",
      trustContext: sender,
      metadata: { acpNotification: { acpSessionId: "acp-session-1" } },
    });

    expect(lastUserMetadata().provenanceContactId).toBeUndefined();
  });

  test.each([
    ["scripted", { scripted: true }],
    ["automated", { metadata: { automated: true } }],
    ["hidden", { metadata: { hidden: true } }],
    [
      "ACP notification",
      { metadata: { acpNotification: { acpSessionId: "acp-session-1" } } },
    ],
    [
      "subagent notification",
      {
        metadata: {
          subagentNotification: {
            subagentId: "subagent-1",
            label: "Research",
            status: "completed",
          },
        },
      },
    ],
  ] as const)(
    "a %s row speaks in their voice without naming them",
    async (kind, extra) => {
      await persistQueuedMessageBody(createContext(), {
        content: "sent on the sender's behalf",
        requestId: `req-author-${kind}`,
        trustContext: sender,
        author: sender,
        ...extra,
      });

      expect(lastUserMetadata().provenanceContactId).toBeUndefined();
    },
  );
});
