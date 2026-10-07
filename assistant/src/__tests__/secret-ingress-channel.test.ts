import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ensureConversationExists } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import * as deliveryCrud from "../persistence/delivery-crud.js";
import { recordInbound } from "../persistence/delivery-crud.js";
import { markProcessed } from "../persistence/delivery-status.js";
import { channelInboundEvents } from "../persistence/schema/conversations.js";
import {
  runSecretIngressCheck,
  type SecretIngressCheckParams,
} from "../runtime/routes/inbound-stages/secret-ingress-check.js";
import { resetAllowlist } from "../security/secret-allowlist.js";
import { setConfig } from "./helpers/set-config.js";

// Every delivery row is real: recordInbound inserts the channel_inbound_events
// row, storePayload/clearPayload flip its rawPayload column, markProcessed
// flips its processingStatus. Pass-through spies record the calls; the row
// itself is read back.

function makeParams(
  eventId: string,
  overrides: Partial<SecretIngressCheckParams> = {},
): SecretIngressCheckParams {
  return {
    eventId,
    sourceChannel: "slack",
    conversationExternalId: "ext-conv-1",
    externalMessageId: "ext-msg-1",
    conversationId: "conv-1",
    content: "hello",
    trimmedContent: "hello",
    attachmentIds: undefined,
    sourceMetadata: undefined,
    actorDisplayName: "Test User",
    actorExternalId: "user-1",
    actorUsername: "testuser",
    trustCtx: {
      trustClass: "member" as const,
      sourceChannel: "slack" as const,
    } as any,
    replyCallbackUrl: undefined,
    ...overrides,
  };
}

let eventSeq = 0;

/** A real inbound event row; its id feeds the check's params. */
function makeEvent(): string {
  const seq = ++eventSeq;
  const result = recordInbound("slack", `ext-chat-${seq}`, `ext-msg-${seq}`, {
    conversationId: "conv-1",
  });
  return result.eventId;
}

function eventRow(eventId: string) {
  return getDb()
    .select()
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId))
    .get();
}

beforeAll(async () => {
  await initializeDb();
  ensureConversationExists("conv-1", "slack");
  // Pass-through spies: the real column writes still land; the tests below
  // observe both the calls and the resulting row state.
  const realStore = deliveryCrud.storePayload;
  const realClear = deliveryCrud.clearPayload;
  spyOn(deliveryCrud, "storePayload").mockImplementation(
    (...args: Parameters<typeof realStore>) => {
      realStore(...args);
      storeCalls.push(args[0]);
    },
  );
  spyOn(deliveryCrud, "clearPayload").mockImplementation(
    (...args: Parameters<typeof realClear>) => {
      realClear(...args);
      clearCalls.push(args[0]);
    },
  );
});

const storeCalls: string[] = [];
const clearCalls: string[] = [];

beforeEach(() => {
  setConfig("secretDetection", { enabled: true, blockIngress: true });
  resetAllowlist();
  storeCalls.length = 0;
  clearCalls.length = 0;
});

describe("secret ingress — channel inbound path", () => {
  test("channel inbound with GOCSPX- secret returns blocked: true", () => {
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
    const result = runSecretIngressCheck(
      makeParams(makeEvent(), {
        content: `My secret is ${secret}`,
        trimmedContent: `My secret is ${secret}`,
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Google OAuth Client Secret");
  });

  test("channel inbound with normal text returns blocked: false", () => {
    const result = runSecretIngressCheck(
      makeParams(makeEvent(), {
        content: "Hello, how can I help?",
        trimmedContent: "Hello, how can I help?",
      }),
    );

    expect(result.blocked).toBe(false);
  });

  test("payload is cleared when blocked", () => {
    const eventId = makeEvent();
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";

    runSecretIngressCheck(
      makeParams(eventId, {
        content: `Secret: ${secret}`,
        trimmedContent: `Secret: ${secret}`,
      }),
    );

    // storePayload persisted the payload before checking, and the block
    // cleared it — the row's rawPayload column is back to null.
    expect(storeCalls).toEqual([eventId]);
    expect(clearCalls).toEqual([eventId]);
    expect(eventRow(eventId)?.rawPayload).toBeNull();
  });

  test("payload is NOT cleared for normal messages", () => {
    const eventId = makeEvent();

    runSecretIngressCheck(
      makeParams(eventId, {
        content: "Normal message",
        trimmedContent: "Normal message",
      }),
    );

    // The stored payload survives — clearPayload never fired.
    expect(storeCalls).toEqual([eventId]);
    expect(clearCalls).toEqual([]);
    expect(eventRow(eventId)?.rawPayload).not.toBeNull();
  });

  test("event is marked as processed (not dead-lettered) when blocked — verified via caller contract", () => {
    // The inbound-message-handler calls markProcessed when
    // runSecretIngressCheck returns blocked: true. Verify the check returns
    // blocked: true, then exercise the real status flip and read it back.
    const eventId = makeEvent();
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234";
    const result = runSecretIngressCheck(
      makeParams(eventId, {
        content: secret,
        trimmedContent: secret,
      }),
    );

    expect(result.blocked).toBe(true);

    // This mirrors inbound-message-handler.ts lines 663-666.
    if (result.blocked) {
      markProcessed(eventId);
    }
    expect(eventRow(eventId)?.processingStatus).toBe("processed");
  });

  test("channel inbound with GitHub token is blocked", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234";
    const result = runSecretIngressCheck(
      makeParams(makeEvent(), {
        content: `Token: ${token}`,
        trimmedContent: `Token: ${token}`,
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("GitHub Token");
  });

  test("channel inbound with Slack bot token is blocked", () => {
    const token = "xoxb-1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUvWx";
    const result = runSecretIngressCheck(
      makeParams(makeEvent(), {
        content: token,
        trimmedContent: token,
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Slack Bot Token");
  });

  test("channel inbound with JWT is not blocked (excluded pattern)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = runSecretIngressCheck(
      makeParams(makeEvent(), {
        content: jwt,
        trimmedContent: jwt,
      }),
    );

    expect(result.blocked).toBe(false);
  });

  test("channel inbound with blockIngress: false allows secrets through", () => {
    setConfig("secretDetection", { enabled: true, blockIngress: false });

    const eventId = makeEvent();
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
    const result = runSecretIngressCheck(
      makeParams(eventId, {
        content: secret,
        trimmedContent: secret,
      }),
    );

    expect(result.blocked).toBe(false);
    // No block, no clear: the stored payload survives.
    expect(clearCalls).toEqual([]);
    expect(eventRow(eventId)?.rawPayload).not.toBeNull();
  });

  test("background dispatch is skipped when blocked (caller reads blocked flag)", () => {
    // The inbound-message-handler skips processChannelMessageInBackground
    // when ingressResult.blocked is true. We verify the function returns
    // the correct blocked flag that the handler uses for this decision.
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const result = runSecretIngressCheck(
      makeParams(makeEvent(), {
        content: `AWS: ${secret}`,
        trimmedContent: `AWS: ${secret}`,
      }),
    );

    // blocked: true means the caller (inbound-message-handler) will skip
    // the background dispatch branch
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("AWS Access Key");
  });
});
