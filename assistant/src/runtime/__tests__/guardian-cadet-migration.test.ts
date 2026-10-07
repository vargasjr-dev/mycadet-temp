/**
 * Unit tests for the narrow reset-drift trust-recovery helper
 * `reResolveTrustOnResetDrift`.
 *
 * The real helper runs against mocked leaf deps: the gateway guardian read
 * (`getGuardianDelivery`/`guardianForChannel`) supplies the authoritative
 * principal, the local-mirror heal target is resolved via
 * `findContactByAddress` (keyed on the gateway guardian's channel address) and
 * written via `repairChannelAddress` (the real `healGuardianBindingDrift`
 * drives this), and the local trust resolver (`resolveTrustContext`) closes
 * the loop. Heal invocations are observed via the contact-store write mock.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockGuardianList: Array<Record<string, unknown>> | null = [];

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => mockGuardianList,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

// Local mirror the real heal repairs. `findContactByAddress` returns the local
// contact (with its cadet channel) the heal writes to;
// `repairChannelAddress` records heal writes.
let mockLocalContact: {
  id: string;
  channels: Array<{ id: string; type: string }>;
} | null = null;
const healWrites: Array<{ principalId: string }> = [];

mock.module("../../contacts/contact-store.js", () => ({
  findContactByAddress: () => mockLocalContact,
  repairChannelAddress: (_channelId: string, principalId: string) => {
    healWrites.push({ principalId });
    return true;
  },
}));

// The local trust resolver returns guardian for the actor; the gate threads
// sourceChannel via the real withSourceChannel wrapper.
mock.module("../trust-context-resolver.js", () => ({
  resolveTrustContext: (input: { actorExternalId?: string }) => ({
    trustClass: "guardian",
    sourceChannel: "cadet",
    resolvedActor: input.actorExternalId,
  }),
  withSourceChannel: (
    sourceChannel: unknown,
    ctx: Record<string, unknown>,
  ) => ({
    ...ctx,
    sourceChannel,
  }),
}));

const { reResolveTrustOnResetDrift } =
  await import("../guardian-cadet-migration.js");

function gatewayGuardian(principalId: string): Record<string, unknown> {
  return {
    channelType: "cadet",
    contactId: "guardian-contact",
    principalId,
    address: principalId,
    status: "active",
  };
}

function localGuardian() {
  return {
    id: "contact-1",
    channels: [{ id: "channel-1", type: "cadet" }],
  };
}

describe("reResolveTrustOnResetDrift", () => {
  beforeEach(() => {
    mockGuardianList = [];
    mockLocalContact = null;
    healWrites.length = 0;
  });

  test("reset drift: heals and returns the re-resolved guardian ctx", async () => {
    // Gateway principal diverges from the incoming JWT; heal repairs the local
    // mirror toward the incoming actor.
    mockGuardianList = [gatewayGuardian("cadet-principal-new")];
    mockLocalContact = localGuardian();

    const ctx = await reResolveTrustOnResetDrift(
      "cadet-principal-old",
      "cadet",
    );

    expect(ctx?.trustClass).toBe("guardian");
    expect(healWrites).toEqual([{ principalId: "cadet-principal-old" }]);
  });

  test("no local mirror to repair still returns the guardian ctx", async () => {
    // The gate passes and the re-resolve yields guardian even when there is no
    // local mirror row for heal to write.
    mockGuardianList = [gatewayGuardian("cadet-principal-new")];
    mockLocalContact = null;

    const ctx = await reResolveTrustOnResetDrift(
      "cadet-principal-old",
      "cadet",
    );

    expect(ctx?.trustClass).toBe("guardian");
    expect(healWrites).toEqual([]);
  });

  test("gateway unreachable (null): returns null, heal not called", async () => {
    mockGuardianList = null;
    mockLocalContact = localGuardian();

    const ctx = await reResolveTrustOnResetDrift(
      "cadet-principal-old",
      "cadet",
    );

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("empty/revoked gateway (no active guardian): returns null, heal not called", async () => {
    mockGuardianList = [];
    mockLocalContact = localGuardian();

    const ctx = await reResolveTrustOnResetDrift(
      "cadet-principal-old",
      "cadet",
    );

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("gateway guardian is a real (non cadet-principal-*) id: returns null", async () => {
    mockGuardianList = [gatewayGuardian("user@example.com")];
    mockLocalContact = localGuardian();

    const ctx = await reResolveTrustOnResetDrift(
      "cadet-principal-old",
      "cadet",
    );

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("incoming principal is not cadet-principal-*: returns null", async () => {
    mockGuardianList = [gatewayGuardian("cadet-principal-new")];
    mockLocalContact = localGuardian();

    const ctx = await reResolveTrustOnResetDrift("user@example.com", "cadet");

    expect(ctx).toBeNull();
    expect(healWrites).toEqual([]);
  });

  test("threads sourceChannel into the returned ctx", async () => {
    mockGuardianList = [gatewayGuardian("cadet-principal-new")];
    mockLocalContact = localGuardian();

    const ctx = await reResolveTrustOnResetDrift(
      "cadet-principal-old",
      "telegram",
    );

    expect(ctx?.sourceChannel).toBe("telegram");
  });
});
