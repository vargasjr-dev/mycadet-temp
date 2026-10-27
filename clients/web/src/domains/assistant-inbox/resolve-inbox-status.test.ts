import { describe, expect, test } from "bun:test";

import {
  resolveInboxStatus,
  type InboxStatusInputs,
} from "./resolve-inbox-status";

const BASE: InboxStatusInputs = {
  cloudAssistantId: "asst-platform",
  addressCount: 1,
  domainsSettled: true,
};

describe("resolveInboxStatus", () => {
  test("loads until the cloud id and the address list are in", () => {
    expect(resolveInboxStatus({ ...BASE, cloudAssistantId: null })).toBe(
      "loading",
    );
    expect(resolveInboxStatus({ ...BASE, addressCount: undefined })).toBe(
      "loading",
    );
  });

  test("ready with an address, whatever the domain list says", () => {
    expect(resolveInboxStatus(BASE)).toBe("ready");
    expect(resolveInboxStatus({ ...BASE, domainsSettled: false })).toBe(
      "ready",
    );
  });

  test("setup only once the domain list has settled", () => {
    expect(
      resolveInboxStatus({ ...BASE, addressCount: 0, domainsSettled: false }),
    ).toBe("loading");
    expect(resolveInboxStatus({ ...BASE, addressCount: 0 })).toBe("setup");
  });
});
