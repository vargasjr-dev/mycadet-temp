import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../../db/connection.js";
import { userProfile } from "../../db/schema.js";
import {
  handleUserMeGet,
  handleUserMePatch,
  handleUsernameAvailableGet,
} from "./user-profile.js";

describe("assistant-owned user profile", () => {
  beforeAll(async () => {
    await initGatewayDb();
  });

  afterAll(() => {
    resetGatewayDb();
  });

  beforeEach(() => {
    getGatewayDb().delete(userProfile).run();
  });

  function patchRequest(body: unknown): Request {
    return new Request("http://localhost:7830/v1/user/me/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("GET seeds an empty profile with a stable id", async () => {
    const res = await handleUserMeGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      username: string;
      email: string;
      first_name: string;
      last_name: string;
    };
    expect(body.id).toBeTruthy();
    expect(body.username).toBe("");
    expect(body.email).toBe("");
    expect(body.first_name).toBe("");
    expect(body.last_name).toBe("");

    // The id is stable across reads.
    const again = await handleUserMeGet();
    expect(((await again.json()) as { id: string }).id).toBe(body.id);
  });

  test("PATCH stores the profile on the assistant and answers the new record", async () => {
    const patchRes = await handleUserMePatch(
      patchRequest({
        username: "ada",
        email: "ada@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
      }),
    );

    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as Record<string, string>;
    expect(body.username).toBe("ada");
    expect(body.email).toBe("ada@example.com");
    expect(body.first_name).toBe("Ada");
    expect(body.last_name).toBe("Lovelace");

    // A later GET answers the stored record — the assistant's own row.
    const got = await handleUserMeGet();
    expect(((await got.json()) as { username: string }).username).toBe("ada");
  });

  test("PATCH preserves the id across updates", async () => {
    const created = (await (
      await handleUserMePatch(patchRequest({ username: "ada" }))
    ).json()) as { id: string };
    const updated = (await (
      await handleUserMePatch(patchRequest({ username: "grace" }))
    ).json()) as { id: string; username: string };
    expect(updated.id).toBe(created.id);
    expect(updated.username).toBe("grace");
  });

  test("PATCH rejects a too-short handle with the canonical DRF field error", async () => {
    const res = await handleUserMePatch(patchRequest({ username: "ab" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      username: Array<{ code: string; string: string }>;
    };
    expect(body.username[0]!.code).toBe("too_short");
    expect(body.username[0]!.string).toContain("at least 3 characters");
  });

  test("PATCH enforces the full local handle rule set", async () => {
    for (const [candidate, expected] of [
      ["a".repeat(31), "too_long"],
      ["Ada Lot", "invalid_chars"],
      ["_ada", "leading_underscore"],
      ["ada_", "trailing_underscore"],
      ["-ada", "leading_hyphen"],
      ["ada-", "trailing_hyphen"],
      ["123456", "all_digits"],
    ] as const) {
      const res = await handleUserMePatch(patchRequest({ username: candidate }));
      const body = (await res.json()) as {
        username: Array<{ code: string }>;
      };
      expect(body.username[0]!.code).toBe(expected);
    }
  });

  test("availability is a local check — valid handles are available, no taken", async () => {
    const ok = await handleUsernameAvailableGet(
      new Request(
        "http://localhost:7830/v1/user/username-available/?username=grace",
        { method: "GET" },
      ),
    );
    expect((await ok.json()) as unknown).toEqual({
      available: true,
      code: null,
      message: null,
    });

    const bad = await handleUsernameAvailableGet(
      new Request(
        "http://localhost:7830/v1/user/username-available/?username=12345",
        { method: "GET" },
      ),
    );
    expect((await bad.json()) as unknown).toEqual({
      available: false,
      code: "all_digits",
      message: "Cannot be all digits.",
    });
  });

  test("PATCH with a schema-invalid body answers a 400 field error, not a 500", async () => {
    const res = await handleUserMePatch(patchRequest({ nope: true }));
    expect(res.status).toBe(400);
  });
});
