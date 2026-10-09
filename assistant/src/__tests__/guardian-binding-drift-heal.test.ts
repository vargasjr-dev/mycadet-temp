import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@mycadet/gateway-client";

let mockGuardians: GuardianDelivery[] | null = [];

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => mockGuardians,
  guardianForChannel: (list: GuardianDelivery[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

import { findContactByAddress } from "../contacts/contact-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { healGuardianBindingDrift } from "../runtime/guardian-cadet-migration.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

/**
 * Gateway delivery for the cadet guardian. `principalId` is the gateway-owned
 * binding principal; `address` is the local channel address the heal resolves
 * its write target by (defaults to the principal for same-principal bindings).
 */
function gatewayGuardian(
  principalId: string,
  address: string = principalId,
): GuardianDelivery {
  return {
    channelType: "cadet",
    contactId: "guardian-contact",
    principalId,
    address,
    status: "active",
  };
}

/** Read the local cadet guardian channel/contact by its channel address. */
function localCadetGuardian(address: string) {
  const contact = findContactByAddress("cadet", address);
  const channel = contact?.channels.find((c) => c.type === "cadet");
  return contact && channel ? { contact, channel } : null;
}

describe("healGuardianBindingDrift", () => {
  beforeEach(() => {
    resetTables();
    mockGuardians = [];
  });

  test("heals drift when both principals have cadet-principal- prefix", async () => {
    // Simulate DB reset: new guardian binding with a different UUID
    createGuardianBinding({
      channel: "cadet",
      guardianExternalUserId: "cadet-principal-new-uuid",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "cadet-principal-new-uuid",
      verifiedVia: "startup-migration",
    });
    mockGuardians = [gatewayGuardian("cadet-principal-new-uuid")];

    // Client arrives with the old JWT principal
    const healed = await healGuardianBindingDrift("cadet-principal-old-uuid");
    expect(healed).toBe(true);

    // The heal repairs the channel identity address to match the JWT. The
    // principalId column is gateway-owned and no longer written locally.
    const guardian = localCadetGuardian("cadet-principal-old-uuid");
    expect(guardian).not.toBeNull();
    expect(guardian!.channel.address).toBe("cadet-principal-old-uuid");
  });

  test("repairs the local mirror toward the JWT when the gateway diverges", async () => {
    // Gateway principal diverges from the incoming JWT — the drift signal. The
    // /v1/messages trust path still reads the local mirror in this plan, so the
    // mirror is repaired toward the JWT or the actor stays `unknown`.
    createGuardianBinding({
      channel: "cadet",
      guardianExternalUserId: "cadet-principal-stale-local",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "cadet-principal-stale-local",
      verifiedVia: "startup-migration",
    });
    // Gateway address matches the local channel address so the heal can resolve
    // its local write target; only the gateway principal has drifted.
    mockGuardians = [
      gatewayGuardian("cadet-principal-gateway", "cadet-principal-stale-local"),
    ];

    const healed = await healGuardianBindingDrift("cadet-principal-jwt");
    expect(healed).toBe(true);

    // The local mirror's identity address now matches the JWT, so a subsequent
    // local trust resolution classifies the actor as guardian rather than
    // unknown. The principalId column is gateway-owned and not written locally.
    const guardian = localCadetGuardian("cadet-principal-jwt");
    expect(guardian!.channel.address).toBe("cadet-principal-jwt");
  });

  test("no-op when principals already match", async () => {
    createGuardianBinding({
      channel: "cadet",
      guardianExternalUserId: "cadet-principal-same",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "cadet-principal-same",
      verifiedVia: "startup-migration",
    });
    mockGuardians = [gatewayGuardian("cadet-principal-same")];

    const healed = await healGuardianBindingDrift("cadet-principal-same");
    expect(healed).toBe(false);
  });

  test("refuses to heal when incoming principal lacks cadet-principal- prefix", async () => {
    createGuardianBinding({
      channel: "cadet",
      guardianExternalUserId: "cadet-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "cadet-principal-aaa",
      verifiedVia: "startup-migration",
    });
    mockGuardians = [gatewayGuardian("cadet-principal-aaa")];

    // External/platform principal — should NOT be adopted
    const healed = await healGuardianBindingDrift("platform-user-12345");
    expect(healed).toBe(false);

    // Guardian unchanged: the local channel identity address still resolves to
    // the original binding (principalId is gateway-owned, no longer local).
    const guardian = localCadetGuardian("cadet-principal-aaa");
    expect(guardian!.channel.address).toBe("cadet-principal-aaa");
  });

  test("refuses to heal when the gateway principal lacks cadet-principal- prefix", async () => {
    createGuardianBinding({
      channel: "cadet",
      guardianExternalUserId: "verified-phone-guardian",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "verified-phone-guardian",
      verifiedVia: "challenge",
    });
    mockGuardians = [gatewayGuardian("verified-phone-guardian")];

    // Even with a cadet-principal- incoming, don't overwrite a real binding
    const healed = await healGuardianBindingDrift("cadet-principal-attacker");
    expect(healed).toBe(false);

    // Guardian unchanged: the local channel identity address still resolves to
    // the original binding (principalId is gateway-owned, no longer local).
    const guardian = localCadetGuardian("verified-phone-guardian");
    expect(guardian!.channel.address).toBe("verified-phone-guardian");
  });

  test("returns false when gateway reports no guardian binding", async () => {
    mockGuardians = [];
    const healed = await healGuardianBindingDrift("cadet-principal-orphan");
    expect(healed).toBe(false);
  });

  test("returns false when the gateway is unreachable (null list)", async () => {
    createGuardianBinding({
      channel: "cadet",
      guardianExternalUserId: "cadet-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "cadet-principal-aaa",
      verifiedVia: "startup-migration",
    });
    mockGuardians = null;

    const healed = await healGuardianBindingDrift("cadet-principal-old-uuid");
    expect(healed).toBe(false);
  });
});
