import { expect, test } from "bun:test";

import { BridgeCapabilityRegistry } from "./capability-registry";

test("bridge registry composes namespaces", () => {
  interface Bridge {
    app: { version: string };
    power: { ready: boolean };
  }
  const registry = new BridgeCapabilityRegistry<Bridge>({
    app: { version: "1.0.0" },
  });

  registry.contribute("power", { ready: true });
  expect(registry.build().app?.version).toBe("1.0.0");
  expect(registry.build().power?.ready).toBe(true);
});
