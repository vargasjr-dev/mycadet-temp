import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  readLockfile,
  resolveExistingLocalSigningKey,
  upsertLockfileAssistant,
} from "@mycadet/local-mode";

// wake, upgrade and recover resolve the existing signing identity through
// @mycadet/local-mode before touching any process. These tests exercise that
// contract the way the CLI consumes it: host lockfile entries, legacy on-disk
// key files, and a renderer save in between.
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
    test("loads the persisted key without creating disk copies", () => {
      expect(
        resolveExistingLocalSigningKey({
          instanceDir,
          signingKey: key.toUpperCase(),
        }),
      ).toBe(key);
      for (const file of legacyPaths()) {
        expect(existsSync(file)).toBe(false);
      }
    });
    for (const index of [0, 1]) {
      test(`recovers legacy source ${index} without rewriting it`, () => {
        put(legacyPaths()[index]!, key);
        expect(resolveExistingLocalSigningKey({ instanceDir })).toBe(key);
        expect(readFileSync(legacyPaths()[index]!)).toEqual(
          Buffer.from(key, "hex"),
        );
      });
    }
    test("matching legacy sources converge", () => {
      for (const file of legacyPaths()) {
        put(file, key);
      }
      expect(
        resolveExistingLocalSigningKey({ instanceDir, signingKey: key }),
      ).toBe(key);
    });
    test("missing state refuses to create an identity", () => {
      expect(() => resolveExistingLocalSigningKey({ instanceDir })).toThrow(
        "signing key missing",
      );
    });
    test("malformed persisted state cannot fall back to a different source", () => {
      put(legacyPaths()[1]!, key);
      for (const invalid of ["", "short", null, 123, "z".repeat(64)]) {
        expect(() =>
          resolveExistingLocalSigningKey({ instanceDir, signingKey: invalid }),
        ).toThrow("signing key invalid");
      }
    });
    test("the host key remains authoritative over stale legacy copies after repair", () => {
      put(legacyPaths()[1]!, other);
      expect(
        resolveExistingLocalSigningKey({ instanceDir, signingKey: key }),
      ).toBe(key);
      expect(readFileSync(legacyPaths()[1]!)).toEqual(
        Buffer.from(other, "hex"),
      );
    });
    test("conflicting legacy copies refuse even without a persisted key", () => {
      put(legacyPaths()[0]!, key);
      put(legacyPaths()[1]!, other);
      expect(() => resolveExistingLocalSigningKey({ instanceDir })).toThrow(
        "signing key conflict",
      );
    });
    test("malformed or unreadable legacy storage is not absence", () => {
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
    test("read/select/save and repeated key loads preserve a retained credential", () => {
      const registry = join(instanceDir, "registry.json");
      const payload = "synthetic-retained-credential";
      const signature = createHmac("sha256", Buffer.from(key, "hex"))
        .update(payload)
        .digest("hex");
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
                signingKey: key,
              },
            },
          ],
        }),
      );
      for (let cycle = 0; cycle < 3; cycle++) {
        const view = readLockfile([registry]);
        expect(
          upsertLockfileAssistant(
            [registry],
            { ...view.assistants[0]! },
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
