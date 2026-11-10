import { describe, expect, test } from "bun:test";

import {
  isPublicBaseUrlRejection,
  publicBaseUrlRejectionMessage,
} from "@/utils/pairing-address";

describe("publicBaseUrlRejectionMessage", () => {
  test("names the specific vendor for a service-website URL", () => {
    expect(
      publicBaseUrlRejectionMessage(
        "service-website",
        "https://login.tailscale.com/admin/invite/abc",
      ),
    ).toBe(
      "This is Tailscale's website, not your assistant's address. Start a tunnel on the host to get one; `cadet tunnel --help` lists the providers.",
    );
    expect(
      publicBaseUrlRejectionMessage("service-website", "https://ngrok.com"),
    ).toContain("ngrok's website");
    expect(
      publicBaseUrlRejectionMessage(
        "service-website",
        "https://dash.cloudflare.com",
      ),
    ).toContain("Cloudflare's website");
  });

  test("falls back to a generic vendor label without a value", () => {
    expect(publicBaseUrlRejectionMessage("service-website")).toContain(
      "the tunnel provider's website",
    );
  });
});

describe("isPublicBaseUrlRejection", () => {
  test("accepts every reason the mapper has copy for", () => {
    for (const reason of [
      "unparseable",
      "loopback",
      "private-address",
      "non-https",
      "service-website",
    ]) {
      expect(isPublicBaseUrlRejection(reason)).toBe(true);
    }
  });

  test("refuses anything else, including inherited object keys", () => {
    expect(isPublicBaseUrlRejection("reason-from-a-newer-host")).toBe(false);
    expect(isPublicBaseUrlRejection("toString")).toBe(false);
    expect(isPublicBaseUrlRejection(undefined)).toBe(false);
  });
});
