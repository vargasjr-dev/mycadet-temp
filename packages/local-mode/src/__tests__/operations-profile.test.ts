import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { forwardOperatorRequest } from "../operations/routes";

/**
 * Dispatches through the real dispatcher — the rows are its internals, so
 * the tests speak the mount's API, not the match/run seam.
 */
const dispatch = (path: string, method = "GET"): Promise<Response | null> =>
  forwardOperatorRequest(
    new Request(`http://operator.test${path}`, { method }),
  );
import { checkUsernameRule } from "../operations/profile";

describe("the operator availability check", () => {
  test("valid handles are available — the single-user assumption means no namespace to collide with", async () => {
    const res = await dispatch(
      "/v1/assistant/user/username-available/?username=grace",
    );
    expect((await res!.json()) as unknown).toEqual({
      available: true,
      code: null,
      message: null,
    });
  });

  test("an invalid handle carries the canonical code and copy", async () => {
    const res = await dispatch(
      "/v1/assistant/user/username-available/?username=ab",
    );
    expect((await res!.json()) as unknown).toEqual({
      available: false,
      code: "too_short",
      message: "Must be at least 3 characters.",
    });
  });

  test("the scoped spelling answers the same check", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-profile-op-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    try {
      fs.mkdirSync(path.join(tmpDir, "cadet"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "cadet", "lockfile.json"),
        JSON.stringify({
          assistants: [
            { assistantId: "any-entry", cloud: "local", port: 7830 },
          ],
          activeAssistant: null,
        }),
      );
      const res = await dispatch(
        "/v1/assistants/any-entry/user/username-available/?username=12345",
      );
      expect((await res!.json()) as unknown).toMatchObject({
        available: false,
        code: "all_digits",
      });
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
