import { describe, expect, test } from "bun:test";

import { CLIENT_FLAG_DEFAULTS } from "@/lib/feature-flags/feature-flag-catalog";

describe("internal-thread-actions flag keys", () => {
  // `use-client-feature-flag-sync` drops any server key the registry does not
  // declare, so the deleted `fork-from-message` alias can never resurface
  // through the sync even if the cloud still sends it.
  test("declares the current key and never the deleted alias", () => {
    expect(CLIENT_FLAG_DEFAULTS).toHaveProperty("internalThreadActions");
    expect(CLIENT_FLAG_DEFAULTS).not.toHaveProperty("forkFromMessage");
  });

  test("defaults off", () => {
    expect(CLIENT_FLAG_DEFAULTS.internalThreadActions).toBe(false);
  });
});
