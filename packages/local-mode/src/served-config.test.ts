import { describe, expect, test } from "bun:test";

import type { Lockfile, LockfileAssistant } from "./lockfile-contract";
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
          port: 7830,
          daemonPort: 7831,
        },
      ],
      activeAssistant: "active",
    };

    expect(servedConfigFromLockfile(lockfile)).toEqual({
      assistantId: "active",
      assistantName: "Example Assistant",
      remote: "docker",
    });
    // The entry carries no bearer at all — the token lives in its xdg
    // file, never in the lockfile the renderer boundary reads.
    const entry = lockfile.assistants[1];
    expect(entry?.cloud === "docker" ? "bearerToken" in entry : undefined).toBe(
      false,
    );
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
        // The raw on-disk shape a pre-xdg lockfile still carries — the
        // parse drops it, and the served stamp never sees it.
        {
          assistantId: "paired",
          cloud: "local",
          bearerToken: "example-host-token",
        } as unknown as LockfileAssistant,
      ],
      activeAssistant: "paired",
    });
    expect(config.assistantId).toBe("paired");
    expect(config.remote).toBe("local");
    // The stamp carries public identity only - no address, no secrets.
    expect(JSON.stringify(config)).not.toContain("example-host-token");
  });
});
