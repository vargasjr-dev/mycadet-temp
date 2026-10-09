import { describe, expect, test } from "bun:test";

import type { AppDefinition } from "../apps/app-store.js";
import { seedApp } from "./helpers/seed-app.js";

const { resolveAppId, missingAppIdError } =
  await import("../tools/apps/resolve-app-id.js");

/**
 * resolveAppId runs on the real app store: each test seeds its apps with
 * fresh conversation ids (real rows persist across tests in a file) and
 * relies on the store's listAppsByConversation + isDirectAppConversation.
 */

/** An app the conversation reached directly (created/operated in it). */
function makeDirectApp(
  id: string,
  updatedAt: number,
  conversationId: string,
): AppDefinition {
  return seedApp({
    id,
    name: id,
    updatedAt,
    createdAt: updatedAt,
    conversationIds: [conversationId],
  });
}

/** An app the conversation only reached through a descendant's lineage. */
function makeInheritedApp(
  id: string,
  updatedAt: number,
  conversationId: string,
): AppDefinition {
  return seedApp({
    id,
    name: id,
    updatedAt,
    createdAt: updatedAt,
    conversationIds: [conversationId],
    inheritedConversationIds: [conversationId],
  });
}

describe("resolveAppId", () => {
  test("returns an explicit non-empty app_id unchanged", () => {
    expect(resolveAppId({ app_id: "explicit" }, "conv-explicit-1")).toBe(
      "explicit",
    );
  });

  test("falls back to the most-recently-updated conversation app when missing", () => {
    makeDirectApp("newest", 30, "conv-newest-1");
    makeDirectApp("older", 10, "conv-newest-1");
    expect(resolveAppId({}, "conv-newest-1")).toBe("newest");
  });

  test("treats a blank app_id as missing", () => {
    makeDirectApp("active", 5, "conv-blank-1");
    expect(resolveAppId({ app_id: "   " }, "conv-blank-1")).toBe("active");
  });

  test("returns null when no app_id is given and the conversation has no app", () => {
    expect(resolveAppId({}, "conv-empty-1")).toBeNull();
  });

  test("prefers a direct app over a more recent lineage-linked one", () => {
    // A background subagent's app is linked into the parent thread and, being
    // newest, heads the list — it must not capture the parent's implicit call.
    makeInheritedApp("background", 30, "conv-direct-1");
    makeDirectApp("foreground", 10, "conv-direct-1");
    expect(resolveAppId({}, "conv-direct-1")).toBe("foreground");
  });

  test("falls back to a lineage-linked app when the conversation has no direct one", () => {
    makeInheritedApp("background-only", 30, "conv-inherited-1");
    expect(resolveAppId({}, "conv-inherited-1")).toBe("background-only");
  });

  test("an app inherited by another conversation is direct here", () => {
    // The app's lineage runs through conv-other (inherited there); conv-1's
    // own association is direct, so conv-1's lookup must treat it as direct.
    seedApp({
      id: "shared",
      name: "shared",
      updatedAt: 30,
      createdAt: 30,
      conversationIds: ["conv-direct-2"],
      inheritedConversationIds: ["conv-inherit-other"],
    });
    expect(resolveAppId({}, "conv-direct-2")).toBe("shared");
  });
});

describe("missingAppIdError", () => {
  test("is an actionable error result", () => {
    const result = missingAppIdError();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("app_create");
  });
});
