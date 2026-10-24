import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  getLockfileData,
  resolveExistingLocalSigningKey,
  saveLockfileAssistant,
} from "@mycadet/local-mode";

// wake, upgrade and recover resolve the existing signing identity through
// @mycadet/local-mode before touching any process. These tests exercise that
// contract the way the CLI consumes it: the on-disk key files the assistant's
// containers persist, and a lockfile save that must not disturb them.
describe("local signing identity continuity", () => {
  let instanceDir: string;
  const key = "ab".repeat(32);
  const other = "cd".repeat(32);
  const legacyPaths = () => [
    join(instanceDir, "gateway-security", "actor-token-signing-key"),
    join(instanceDir, "workspace", "deprecated", "actor-token-signing-key"),
  ];
  function put(file: string, hex: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(hex, "hex"), { mode: 0o600 });
  }
  beforeEach(() => {
    instanceDir = mkdtempSync(join(tmpdir(), "signing-continuity-"));
  });
  afterEach(() => {
    rmSync(instanceDir, { recursive: true, force: true });
  });

  describe("resolveExistingLocalSigningKey", () => {
    for (const index of [0, 1]) {
      test(`recovers key file ${index} without rewriting it`, () => {
        put(legacyPaths()[index]!, key);
        expect(resolveExistingLocalSigningKey({ instanceDir })).toBe(key);
        expect(readFileSync(legacyPaths()[index]!)).toEqual(
          Buffer.from(key, "hex"),
        );
      });
    }
    test("matching key files converge", () => {
      for (const file of legacyPaths()) {
        put(file, key);
      }
      expect(resolveExistingLocalSigningKey({ instanceDir })).toBe(key);
    });
    test("missing state refuses to create an identity", () => {
      expect(() => resolveExistingLocalSigningKey({ instanceDir })).toThrow(
        "signing key missing",
      );
    });
    test("conflicting key files refuse", () => {
      put(legacyPaths()[0]!, key);
      put(legacyPaths()[1]!, other);
      expect(() => resolveExistingLocalSigningKey({ instanceDir })).toThrow(
        "signing key conflict",
      );
    });
    test("malformed or unreadable key storage is not absence", () => {
      put(legacyPaths()[0]!, "ab");
      expect(() => resolveExistingLocalSigningKey({ instanceDir })).toThrow(
        "signing key invalid",
      );
      rmSync(legacyPaths()[0]!);
      mkdirSync(legacyPaths()[0]!);
      expect(() => resolveExistingLocalSigningKey({ instanceDir })).toThrow(
        /signing key (invalid|unreadable)/,
      );
    });
    test("a foreign instance cannot supply a key", () => {
      put(legacyPaths()[1]!, key);
      expect(() =>
        resolveExistingLocalSigningKey({
          instanceDir: join(instanceDir, "other"),
        }),
      ).toThrow("signing key missing");
    });
  });

  describe("across desktop saves and wake cycles", () => {
    test("a lockfile save never disturbs the key file the identity resolves from", () => {
      const registry = join(instanceDir, "registry.json");
      const payload = "synthetic-retained-credential";
      const signature = createHmac("sha256", Buffer.from(key, "hex"))
        .update(payload)
        .digest("hex");
      put(legacyPaths()[0]!, key);
      writeFileSync(
        registry,
        JSON.stringify({
          assistants: [
            {
              assistantId: "example",
              cloud: "local",
              resources: {
                instanceDir,
                gatewayPort: 7830,
                daemonPort: 7831,
              },
            },
          ],
        }),
      );
      for (let cycle = 0; cycle < 3; cycle++) {
        const view = getLockfileData([registry]);
        if (!view.ok) {
          throw new Error("fixture read failed");
        }
        expect(
          saveLockfileAssistant(
            [registry],
            { ...view.data.assistants[0]! },
            "example",
          ).ok,
        ).toBe(true);
        const stored = JSON.parse(readFileSync(registry, "utf8"));
        const restored = resolveExistingLocalSigningKey(
          stored.assistants[0].resources,
        );
        expect(
          createHmac("sha256", Buffer.from(restored, "hex"))
            .update(payload)
            .digest("hex"),
        ).toBe(signature);
      }
    });
  });
});
