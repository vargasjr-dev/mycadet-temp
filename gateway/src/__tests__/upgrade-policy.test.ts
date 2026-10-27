import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import "./test-preload.js";

import {
  createUpgradePolicyGetHandler,
  createUpgradePolicyPutHandler,
  defaultUpgradePolicy,
} from "../http/routes/upgrade-policy.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body?: unknown, method = "PUT"): Request {
  if (body !== undefined) {
    return new Request("http://localhost/v1/upgrade-policy", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request("http://localhost/v1/upgrade-policy", { method });
}

function validPolicy() {
  return defaultUpgradePolicy();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgrade policy", () => {
  describe("GET handler", () => {
    test("returns defaults when no row exists", async () => {
      const handler = createUpgradePolicyGetHandler();
      const res = await handler(makeRequest(undefined, "GET"));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(defaultUpgradePolicy());
    });

    test("returns the stored policy after a PUT", async () => {
      const putHandler = createUpgradePolicyPutHandler();
      const getHandler = createUpgradePolicyGetHandler();

      const policy = {
        ...validPolicy(),
        enabled: false,
        schedule: {
          ...validPolicy().schedule,
          frequency: "monthly",
          days_of_week: [],
          days_of_month: [1, 15],
          window: { start: "03:30", end: "04:30" },
        },
      };
      const putRes = await putHandler(makeRequest(policy));
      expect(putRes.status).toBe(200);

      const getRes = await getHandler(makeRequest(undefined, "GET"));
      const data = await getRes.json();
      expect(data).toEqual(policy);
    });

    test("answers defaults instead of erroring when the stored row is corrupt", async () => {
      const putHandler = createUpgradePolicyPutHandler();
      await putHandler(makeRequest(validPolicy()));

      // Corrupt the singleton row directly — the read discipline (a bad
      // write can only cost the policy, never the runtime) answers defaults.
      const { getGatewayDb } = await import("../db/connection.js");
      const { upgradePolicy } = await import("../db/schema.js");
      const { eq } = await import("drizzle-orm");
      getGatewayDb()
        .update(upgradePolicy)
        .set({ policy: "{not json" })
        .where(eq(upgradePolicy.id, 1))
        .run();

      const getHandler = createUpgradePolicyGetHandler();
      const res = await getHandler(makeRequest(undefined, "GET"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(defaultUpgradePolicy());
    });
  });

  describe("PUT handler", () => {
    test("full-replaces the policy and echoes it back", async () => {
      const handler = createUpgradePolicyPutHandler();

      const policy = {
        ...validPolicy(),
        timezone: "America/New_York",
        schedule: {
          frequency: "weekly",
          days_of_week: [0, 2, 4],
          days_of_month: [],
          window: { start: "12:00", end: "13:00" },
        },
      } as const;
      const res = await handler(makeRequest(policy));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(policy);
    });

    test("rejects a malformed policy with 400", async () => {
      const handler = createUpgradePolicyPutHandler();

      const res = await handler(
        makeRequest({ enabled: true, timezone: "UTC", schedule: "nope" }),
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid upgrade policy");
    });

    test("rejects a non-JSON body with 400", async () => {
      const handler = createUpgradePolicyPutHandler();

      const res = await handler(
        new Request("http://localhost/v1/upgrade-policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{broken",
        }),
      );

      expect(res.status).toBe(400);
    });

    test("the window is HH:MM (UTC) or rejected", async () => {
      const handler = createUpgradePolicyPutHandler();

      const bad = {
        ...validPolicy(),
        schedule: {
          ...validPolicy().schedule,
          window: { start: "25:99", end: "08:00" },
        },
      };
      const res = await handler(makeRequest(bad));

      expect(res.status).toBe(400);
    });
  });
});
