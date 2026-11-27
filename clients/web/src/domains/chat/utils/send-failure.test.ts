import { describe, expect, it } from "bun:test";

import { classifySendFailure } from "@/domains/chat/utils/send-failure";

describe("classifySendFailure", () => {
  it("keeps the message and conversation on LLM-level auth failures", () => {
    for (const status of [401, 403]) {
      const failure = classifySendFailure(status, "invalid_api_key", undefined);
      expect(failure.keepMessageAndConversation).toBe(true);
      expect(failure.title).toBe("Assistant couldn't respond");
      // A known provider code resolves through the usual copy table.
      expect(failure.message).toContain("API key");
    }
  });

  it("falls back to honest copy when the auth failure carries no code", () => {
    const failure = classifySendFailure(401, undefined, undefined);
    expect(failure.keepMessageAndConversation).toBe(true);
    expect(failure.message).toContain("model provider");
  });

  it("gives 502 a can't-reach framing", () => {
    const failure = classifySendFailure(502, undefined, "upstream gone");
    expect(failure.keepMessageAndConversation).toBe(false);
    expect(failure.title).toBe("Can't reach your assistant");
    expect(failure.message).toMatch(/reach your assistant/);
  });

  it("gives 503 a temporary/unavailable framing", () => {
    const failure = classifySendFailure(503, undefined, undefined);
    expect(failure.title).toBe("Assistant unavailable");
    expect(failure.message).toMatch(/starting up or temporarily busy/);
  });

  it("gives 500/504 an unexpected-error framing", () => {
    for (const status of [500, 504]) {
      const failure = classifySendFailure(status, undefined, undefined);
      expect(failure.title).toBe("Unexpected assistant error");
      expect(failure.message).toMatch(/unexpected/i);
    }
  });

  it("keeps Message blocked for 4xx rejections", () => {
    const failure = classifySendFailure(
      422,
      "secret_blocked",
      "Looks like an API key",
    );
    expect(failure.keepMessageAndConversation).toBe(false);
    expect(failure.title).toBe("Message blocked");
    expect(failure.message).toBe("Looks like an API key");
  });

  it("treats a status-less failure as a blocked message (legacy)", () => {
    const failure = classifySendFailure(undefined, undefined, undefined);
    expect(failure.title).toBe("Message blocked");
    expect(failure.keepMessageAndConversation).toBe(false);
  });
});
