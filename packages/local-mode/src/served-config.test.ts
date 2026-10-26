import { describe, expect, test } from "bun:test";

import type { Lockfile } from "./lockfile-contract";
import { servedConfigFromLockfile } from "./served-config";

describe("servedConfigFromLockfile", () => {
  test("selects the active entry and exposes only public config fields", () => {
    const lockfile: Lockfile = {
      assistants: [
        { assistantId: "other", cloud: "local" },
        {
          assistantId: "active",
          name: "Example Assistant",
          cloud: "docker",
          bearerToken: "example-host-token",
          guardianBootstrapSecret: "example-bootstrap-secret",
          resources: { gatewayPort: 7830, daemonPort: 7831 },
        },
      ],
      activeAssistant: "active",
    };

    expect(servedConfigFromLockfile(lockfile)).toEqual({
      assistantId: "active",
      assistantName: "Example Assistant",
      remote: "docker",
    });
    expect(lockfile.assistants[1]?.bearerToken).toBe("example-host-token");
  });

  test("uses the sole entry when no active entry matches", () => {
    expect(
      servedConfigFromLockfile({
        assistants: [{ assistantId: "sole", cloud: "local" }],
        activeAssistant: "removed",
      }).assistantId,
    ).toBe("sole");
  });

  test("does not select an arbitrary entry from an ambiguous registry", () => {
    expect(
      servedConfigFromLockfile({
        assistants: [
          { assistantId: "first", cloud: "local" },
          { assistantId: "second", cloud: "local" },
        ],
        activeAssistant: null,
      }).assistantId,
    ).toBeUndefined();
  });

  test("an empty registry has no served assistant", () => {
    expect(
      servedConfigFromLockfile({ assistants: [], activeAssistant: null })
        .assistantId,
    ).toBeUndefined();
  });

  test("never exposes the guardian credential, even for a paired entry", () => {
    const config = servedConfigFromLockfile({
      assistants: [
        {
          assistantId: "paired",
          cloud: "local",
          bearerToken: "example-host-token",
        },
      ],
      activeAssistant: "paired",
    });
    expect(config.assistantId).toBe("paired");
    expect(config.remote).toBe("local");
    // The stamp carries public identity only - no address, no secrets.
    expect(JSON.stringify(config)).not.toContain("example-host-token");
  });
});
