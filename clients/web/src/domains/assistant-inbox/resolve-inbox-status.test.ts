import { describe, expect, test } from "bun:test";

import {
  resolveInboxStatus,
  type InboxStatusInputs,
} from "./resolve-inbox-status";

const BASE: InboxStatusInputs = {
  hosting: "cloud",
  cloudAssistantId: "asst-platform",
  addressCount: 1,
  domainsSettled: true,
};

describe("resolveInboxStatus", () => {
  test("loads while hosting is still resolving", () => {
    expect(resolveInboxStatus({ ...BASE, hosting: "resolving" })).toBe(
      "loading",
    );
  });

  test("is unavailable off the cloud, whatever else is known", () => {
    expect(resolveInboxStatus({ ...BASE, hosting: "self_hosted" })).toBe(
      "unavailable",
    );
    expect(resolveInboxStatus({ ...BASE, hosting: "unavailable" })).toBe(
      "unavailable",
    );
  });

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
