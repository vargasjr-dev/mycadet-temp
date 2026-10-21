import { describe, expect, test } from "bun:test";

import { noConnectionsMessage } from "./status.js";

describe("noConnectionsMessage", () => {
  test("names the connect command", async () => {
    const msg = await noConnectionsMessage("google");
    expect(msg).toBe(
      "No active connections for google.\n" +
        "Connect with `assistant oauth connect google`.\n",
    );
  });
});
