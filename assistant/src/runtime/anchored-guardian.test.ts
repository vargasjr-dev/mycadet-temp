/**
 * Unit tests for `resolveAnchoredGuardian`.
 *
 * Covers the gateway arms (source-channel match validated against the cadet
 * anchor, vellum-anchor fallback) and the cosmetic `requireAnchorPrincipal`
 * guard.
 */
import { describe, expect, test } from "bun:test";

import type { GuardianDelivery } from "@mycadet/gateway-client";

import { resolveAnchoredGuardian } from "./anchored-guardian.js";

function gw(
  g: Partial<GuardianDelivery> & { channelType: string; address: string },
): GuardianDelivery {
  return {
    contactId: `c-${g.channelType}`,
    status: "active",
    ...g,
  };
}

describe("resolveAnchoredGuardian — gateway arm", () => {
  test("source-channel guardian matching the anchor wins", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({
          channelType: "vellum",
          address: "v-addr",
          principalId: "p-anchor",
          displayName: "Cadet",
        }),
        gw({
          channelType: "telegram",
          address: "tg-addr",
          principalId: "p-anchor",
          displayName: "Alice",
        }),
      ],
      sourceChannel: "telegram",
    });
    expect(result).toEqual({
      principalId: "p-anchor",
      address: "tg-addr",
      displayName: "Alice",
      channelType: "telegram",
      source: "source-channel-contact",
    });
  });

  test("source-channel guardian NOT matching the anchor falls back to vellum-anchor", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({
          channelType: "vellum",
          address: "v-addr",
          principalId: "p-anchor",
          displayName: "Cadet",
        }),
        gw({
          channelType: "telegram",
          address: "tg-addr",
          principalId: "p-other",
          displayName: "Stale",
        }),
      ],
      sourceChannel: "telegram",
    });
    expect(result).toEqual({
      principalId: "p-anchor",
      address: "v-addr",
      displayName: "Cadet",
      channelType: "vellum",
      source: "vellum-anchor",
    });
  });

  test("no source-channel guardian falls back to vellum-anchor", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({
          channelType: "vellum",
          address: "v-addr",
          principalId: "p-anchor",
          displayName: "Cadet",
        }),
      ],
      sourceChannel: "telegram",
    });
    expect(result?.source).toBe("vellum-anchor");
    expect(result?.principalId).toBe("p-anchor");
  });
});

describe("resolveAnchoredGuardian — gateway empty", () => {
  test("null gateway list returns null", () => {
    const result = resolveAnchoredGuardian({
      guardians: null,
      sourceChannel: "telegram",
    });
    expect(result).toBeNull();
  });

  test("empty gateway list returns null", () => {
    const result = resolveAnchoredGuardian({
      guardians: [],
      sourceChannel: "telegram",
    });
    expect(result).toBeNull();
  });
});

describe("resolveAnchoredGuardian — requireAnchorPrincipal (cosmetic label)", () => {
  test("cadet guardian with a null principal degrades to null", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({
          channelType: "vellum",
          address: "v-addr",
          principalId: null,
          displayName: "Cadet",
        }),
      ],
      sourceChannel: "telegram",
      requireAnchorPrincipal: true,
    });
    expect(result).toBeNull();
  });

  test("without requireAnchorPrincipal a null-principal cadet still resolves", () => {
    const result = resolveAnchoredGuardian({
      guardians: [
        gw({
          channelType: "vellum",
          address: "v-addr",
          principalId: null,
          displayName: "Cadet",
        }),
      ],
      sourceChannel: "telegram",
    });
    expect(result?.source).toBe("vellum-anchor");
    expect(result?.principalId).toBeNull();
  });
});
