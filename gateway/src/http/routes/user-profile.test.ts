import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../../db/connection.js";
import { contacts, contactChannels } from "../../db/schema.js";
import { handleUserMeGet, handleUserMePatch } from "./user-profile.js";

function seedGuardianWithChannels(): string {
  const db = getGatewayDb();
  const now = Date.now();
  db.insert(contacts)
    .values({
      id: "guardian-1",
      displayName: "Ada Lovelace",
      role: "guardian",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id: "channel-cadet",
      contactId: "guardian-1",
      type: "cadet",
      address: "ada",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id: "channel-email",
      contactId: "guardian-1",
      type: "email",
      address: "ada@example.com",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return "guardian-1";
}

describe("the gateway's user profile api", () => {
  beforeAll(async () => {
    await initGatewayDb();
  });

  afterAll(() => {
    resetGatewayDb();
  });

  beforeEach(() => {
    const db = getGatewayDb();
    db.delete(contactChannels).run();
    db.delete(contacts).run();
  });

  function patchRequest(body: unknown): Request {
    return new Request("http://localhost:7830/v1/user/me/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("GET projects the guardian's existing rows — cadet address, email address, displayName", async () => {
    seedGuardianWithChannels();

    const res = await handleUserMeGet();
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      id: "guardian-1",
      username: "ada",
      email: "ada@example.com",
      first_name: "Ada Lovelace",
      last_name: "",
    });
  });

  test("an assistant with no bound guardian answers the empty shell", async () => {
    const res = await handleUserMeGet();
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      id: "",
      username: "",
      email: "",
      first_name: "",
      last_name: "",
    });
  });

  test("PATCH writes the guardian's cadet channel address", async () => {
    seedGuardianWithChannels();

    const res = await handleUserMePatch(patchRequest({ username: "grace" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ username: "grace" });

    const db = getGatewayDb();
    const row = db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "channel-cadet"))
      .get();
    expect(row?.address).toBe("grace");
  });

  test("PATCH rejects a bad handle with the canonical DRF field error", async () => {
    seedGuardianWithChannels();

    const res = await handleUserMePatch(patchRequest({ username: "12345" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      username: Array<{ code: string; string: string }>;
    };
    expect(body.username[0]!.code).toBe("all_digits");
    expect(body.username[0]!.string).toContain("all digits");
  });

  test("PATCH with a schema-invalid body answers a 400 field error, not a 500", async () => {
    seedGuardianWithChannels();

    const res = await handleUserMePatch(patchRequest({ nope: true }));
    expect(res.status).toBe(400);
  });
});

