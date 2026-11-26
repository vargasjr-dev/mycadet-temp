/**
 * Tests for the IPC-only `invite_redeemed` info-mirror handler: the gateway
 * fires it best-effort after a gateway-native redemption, and the daemon
 * upserts the local contact/channel identity row. Repeated delivery of the
 * same outcome must be idempotent.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { useMemorySecureKeys } from "./helpers/secure-keys.js";

useMemorySecureKeys();
import { findContactChannel, getContact } from "../contacts/contact-store.js";
import { handleInviteRedeemed } from "../ipc/routes/invite-ipc-routes.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

function resetTables() {
  getSqlite().run("DELETE FROM contact_channels");
  getSqlite().run("DELETE FROM contacts");
}

const OUTCOME = {
  inviteId: "inv-1",
  contactId: "contact-target-1",
  sourceChannel: "telegram",
  memberExternalUserId: "U_SENDER",
  memberExternalChatId: "chat-sender",
  displayName: "Curated Name",
  username: "sender",
  result: "redeemed",
};

describe("handleInviteRedeemed (invite_redeemed)", () => {
  beforeEach(resetTables);

  test("mirrors the local contact/channel info row from the outcome", () => {
    const result = z
      .looseObject({ ok: z.boolean() })
      .parse(handleInviteRedeemed({ body: { ...OUTCOME } }));

    expect(result.ok).toBe(true);

    const contact = getContact("contact-target-1");
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Curated Name");

    const found = findContactChannel({
      channelType: "telegram",
      address: "U_SENDER",
    });
    expect(found).not.toBeNull();
    expect(found!.contact.id).toBe("contact-target-1");
    expect(found!.channel.externalChatId).toBe("chat-sender");
  });

  test("is idempotent for repeated delivery of the same outcome", () => {
    handleInviteRedeemed({ body: { ...OUTCOME } });
    handleInviteRedeemed({ body: { ...OUTCOME } });

    const contactRows = getSqlite()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM contacts")
      .get()!;
    const channelRows = getSqlite()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM contact_channels")
      .get()!;

    expect(contactRows.n).toBe(1);
    expect(channelRows.n).toBe(1);

    const found = findContactChannel({
      channelType: "telegram",
      address: "U_SENDER",
    });
    expect(found!.contact.id).toBe("contact-target-1");
  });

  test("rejects a malformed outcome payload", () => {
    expect(() =>
      handleInviteRedeemed({ body: { inviteId: "inv-1" } }),
    ).toThrow();
  });
});
