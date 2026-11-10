import { describe, expect, test } from "bun:test";

import { matchOperatorRequest } from "../operations/routes";
import { checkUsernameRule } from "../operations/profile";

describe("the operator availability check", () => {
  test("valid handles are available — the single-user assumption means no namespace to collide with", async () => {
    const match = matchOperatorRequest(
      "/v1/assistant/user/username-available/",
      "GET",
    );
    expect(match).not.toBeNull();
    const res = await match!.route.run({
      assistantId: match!.assistantId,
      path: "/v1/assistant/user/username-available/?username=grace",
    });
    expect((await res!.json()) as unknown).toEqual({
      available: true,
      code: null,
      message: null,
    });
  });

  test("an invalid handle carries the canonical code and copy", async () => {
    const match = matchOperatorRequest(
      "/v1/assistant/user/username-available/",
      "GET",
    );
    const res = await match!.route.run({
      assistantId: match!.assistantId,
      path: "/v1/assistant/user/username-available/?username=ab",
    });
    expect((await res!.json()) as unknown).toEqual({
      available: false,
      code: "too_short",
      message: "Must be at least 3 characters.",
    });
  });

  test("the scoped spelling answers the same check", async () => {
    const match = matchOperatorRequest(
      "/v1/assistants/any-entry/user/username-available/",
      "GET",
    );
    expect(match).not.toBeNull();
    const res = await match!.route.run({
      assistantId: match!.assistantId,
      path: "/v1/assistants/any-entry/user/username-available/?username=12345",
    });
    expect((await res!.json()) as unknown).toMatchObject({
      available: false,
      code: "all_digits",
    });
  });

  test("the rule set is the canonical code list", () => {
    expect(checkUsernameRule("ab")).toBe("too_short");
    expect(checkUsernameRule("a".repeat(31))).toBe("too_long");
    expect(checkUsernameRule("Ada Lovelace")).toBe("invalid_chars");
    expect(checkUsernameRule("_ada")).toBe("leading_underscore");
    expect(checkUsernameRule("ada_")).toBe("trailing_underscore");
    expect(checkUsernameRule("-ada")).toBe("leading_hyphen");
    expect(checkUsernameRule("ada-")).toBe("trailing_hyphen");
    expect(checkUsernameRule("123456")).toBe("all_digits");
    expect(checkUsernameRule("ada-lovelace")).toBeNull();
  });
});
