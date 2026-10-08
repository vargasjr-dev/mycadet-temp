import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DAEMON_STOP_TIMEOUT_MS,
  DAEMON_READINESS_WINDOW_MS,
  HOST_WRAPPER_HEADROOM_MS,
  HOST_WRAPPER_LONG_HEADROOM_MS,
} from "../lifecycle-budgets";

const SRC = join(import.meta.dirname, "..");

function readSource(name: string): string {
  return readFileSync(join(SRC, name), "utf-8");
}

/**
 * The budgets' contract (see lifecycle-budgets.ts): every host-wrapper timeout
 * must sit ABOVE the budget of the command it wraps, so a slow-but-succeeding
 * command is never killed partway and misreported as a failure. These tests
 * pin the derivation so the constants can't drift apart silently.
 */
describe("lifecycle budgets", () => {
  test("every budget is a positive number", () => {
    for (const budget of [
      DAEMON_STOP_TIMEOUT_MS,
      DAEMON_READINESS_WINDOW_MS,
      HOST_WRAPPER_HEADROOM_MS,
      HOST_WRAPPER_LONG_HEADROOM_MS,
    ]) {
      expect(budget).toBeGreaterThan(0);
    }
  });

  test("the long headroom exceeds the regular headroom", () => {
    expect(HOST_WRAPPER_LONG_HEADROOM_MS).toBeGreaterThan(
      HOST_WRAPPER_HEADROOM_MS,
    );
  });

  test.each(["sleep.ts", "retire.ts"])(
    "%s derives its timeout from the shared budgets, not a local guess",
    (name) => {
      const source = readSource(name);
      expect(source).toContain('from "./lifecycle-budgets"');
    },
  );
});
