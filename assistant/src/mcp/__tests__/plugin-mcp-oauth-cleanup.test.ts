import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { useFaultableSecureKeyMap } from "../../__tests__/helpers/secure-keys.js";
import * as secureKeysModule from "../../security/secure-keys.js";

// The REAL secure-keys module pinned to a faultable memory backend. The
// spies are pass-through: they record calls while the real fns run against
// the pinned backend; the two failure tests stage their faults per-call.
const { store, setAllUnreachable } = useFaultableSecureKeyMap();
const deleteSpy = spyOn(secureKeysModule, "deleteSecureKeyAsync");

const { deletePluginMcpOAuthCredentials } =
  await import("../mcp-oauth-provider.js");

describe("plugin MCP OAuth credential cleanup", () => {
  beforeEach(() => {
    store.clear();
    setAllUnreachable(false);
    deleteSpy.mockClear();
  });

  test("deletes only the exact plugin owner prefix", async () => {
    store.set("mcp-plugin/v1/cGx1Z2lu/client/digest/tokens", "t1");
    store.set("mcp-plugin/v1/cGx1Z2lu/client/digest/discovery", "d1");
    store.set("mcp-plugin/v1/cGx1Z2luMg/client/digest/tokens", "t2");
    store.set("mcp:plugin:tokens", "t3");

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([
      "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens",
      "mcp-plugin/v1/cGx1Z2lu/client/digest/discovery",
    ]);
    expect(result).toEqual({
      ok: true,
      unreachable: false,
      matchedKeys: [
        "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens",
        "mcp-plugin/v1/cGx1Z2lu/client/digest/discovery",
      ],
      failedKeys: [],
    });
  });

  test("does not attempt deletion when credential storage is unreachable", async () => {
    setAllUnreachable(true);

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      unreachable: true,
      matchedKeys: [],
      failedKeys: [],
    });
  });

  test("reports any matched key that could not be deleted", async () => {
    const key = "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens";
    store.set(key, "t1");
    deleteSpy.mockImplementationOnce(async () => "error" as const);

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(result.ok).toBe(false);
    expect(result.failedKeys).toEqual([key]);
  });

  test("reports a rejected matched-key deletion as a failure", async () => {
    const key = "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens";
    store.set(key, "t1");
    deleteSpy.mockImplementationOnce(async () => {
      throw new Error("backend failed");
    });

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(result.ok).toBe(false);
    expect(result.unreachable).toBe(false);
    expect(result.failedKeys).toEqual([key]);
  });
});
