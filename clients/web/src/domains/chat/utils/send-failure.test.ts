import { describe, expect, it } from "bun:test";

import { classifySendFailure } from "@/domains/chat/utils/send-failure";

describe("classifySendFailure", () => {
  it("gives 502 a can't-reach framing", () => {
    const failure = classifySendFailure(502, undefined, "upstream gone");
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

  it("keeps the blocked framing for 4xx rejections", () => {
    const failure = classifySendFailure(
      422,
      "secret_blocked",
      "Looks like an API key",
    );
    expect(failure.title).toBe("Message blocked");
    expect(failure.message).toBe("Looks like an API key");
  });

  it("treats a status-less failure as a blocked message", () => {
    const failure = classifySendFailure(undefined, undefined, undefined);
    expect(failure.title).toBe("Message blocked");
  });
});
