/**
 * The plugin email history is the BYO lane's memory: webhook retries must
 * not grow copies, replies must record what the provider actually accepted,
 * and the capability token must survive restarts. Nothing here touches
 * Cadet Cloud Email's store — this is the plugin lane's own memory.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "bun:test";

import "../__tests__/test-preload.js";
import {
  ensureEmailReplyToken,
  getEmailMessageById,
  listEmailMessages,
  recordInboundEmail,
  recordOutboundEmail,
  verifyEmailReplyToken,
} from "./email-message-store.js";
import { initGatewayDb, resetGatewayDb } from "./connection.js";

const PARENT = {
  assistantId: "asst-test",
  provider: "resend",
  messageId: "<shannon-1@vargasjr.dev>",
  inReplyTo: null,
  referencesChain: null,
  fromAddr: "shannon@example.com",
  toAddr: "assistant@vargasjr.dev",
  subject: "My cadet.ai Issue",
  bodyText: "The reply threading seems broken.",
};

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

describe("recordInboundEmail", () => {
  it("inserts a received message and reports it as new", () => {
    const { row, inserted } = recordInboundEmail(PARENT);
    expect(inserted).toBe(true);
    expect(row.direction).toBe("in");
    expect(row.messageId).toBe("<shannon-1@vargasjr.dev>");
    expect(row.fromAddr).toBe("shannon@example.com");
  });

  it("is idempotent on Message-ID — a webhook retry does not grow a copy", () => {
    const { row, inserted } = recordInboundEmail(PARENT);
    expect(inserted).toBe(false);
    const all = listEmailMessages(50);
    expect(all.filter((r) => r.messageId === PARENT.messageId)).toHaveLength(1);
    expect(all[0].id).toBe(row.id);
  });
});

describe("recordOutboundEmail", () => {
  it("records the reply with the provider's message id", () => {
    const parent = listEmailMessages(50).find(
      (r) => r.messageId === PARENT.messageId,
    );
    expect(parent).toBeDefined();
    const row = recordOutboundEmail({
      assistantId: PARENT.assistantId,
      provider: PARENT.provider,
      messageId: "<reply-1@resend.dev>",
      inReplyTo: PARENT.messageId,
      referencesChain: PARENT.messageId,
      fromAddr: PARENT.toAddr,
      toAddr: PARENT.fromAddr,
      subject: "Re: My cadet.ai Issue",
      bodyText: "We're on it!\n\nOn Mon, Shannon wrote:\n> The reply…",
    });
    expect(row.direction).toBe("out");
    expect(row.inReplyTo).toBe("<shannon-1@vargasjr.dev>");
    const fetched = getEmailMessageById(row.id);
    expect(fetched?.messageId).toBe("<reply-1@resend.dev>");
  });
});

describe("listEmailMessages", () => {
  it("lists newest first", () => {
    const all = listEmailMessages(50);
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }
  });
});

describe("reply capability token", () => {
  it("mints once and verifies the same value", () => {
    const first = ensureEmailReplyToken();
    const second = ensureEmailReplyToken();
    expect(second).toBe(first);
    expect(verifyEmailReplyToken(first)).toBe(true);
    expect(verifyEmailReplyToken("not-the-token")).toBe(false);
    expect(verifyEmailReplyToken(null)).toBe(false);
  });
});
