import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  BACKUP_PROFILE_KEYS,
  DEFAULT_PROFILE_KEYS,
  FALLBACK_PROFILE_BY_KEY,
} from "../config/default-profile-names.js";
import { LLMSchema } from "../config/schemas/llm.js";

// The default provider lives in the `llm.default` blob (provider +
// optional connection pin) since #139; the July-era `llm.defaultProvider`
// column key is retired and zod strips it silently, so every fixture here
// writes the blob.
describe("LLMSchema fallbackProfile", () => {
  test.each([...DEFAULT_PROFILE_KEYS])(
    "accepts the code-owned managed pointer for %s",
    (profileName) => {
      const result = LLMSchema.safeParse({
        default: { provider: "cadet" },
        profiles: {
          [profileName]: {
            source: "cloud",
            fallbackProfile: FALLBACK_PROFILE_BY_KEY[profileName],
          },
        },
      });
      expect(result.success).toBe(true);
    },
  );

  test("rejects a user-authored fallbackProfile even when its target exists", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "backup" },
        backup: { speed: "fast" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("Automatic fallbacks are code-owned"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("rejects a fallbackProfile on a user-owned default-profile shadow", () => {
    const profileName = DEFAULT_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        [profileName]: {
          source: "user",
          fallbackProfile: FALLBACK_PROFILE_BY_KEY[profileName],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a cloud default pointing anywhere except its code-owned backup", () => {
    const profileName = DEFAULT_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        [profileName]: {
          source: "cloud",
          fallbackProfile: "custom-backup",
        },
        "custom-backup": { speed: "fast" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("empty-string fallbackProfile is rejected at field level", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("profiles without fallbackProfile still parse (back-compat)", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        fast: { speed: "fast", effort: "low" },
        thorough: { effort: "high", maxTokens: 128000 },
      },
      callSites: {
        mainAgent: { profile: "thorough" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles["fast"]?.fallbackProfile).toBeUndefined();
    }
  });

  test("a code-owned fallback pointer is rejected on a non-cloud column", () => {
    const profileName = DEFAULT_PROFILE_KEYS[0];
    for (const provider of ["anthropic", "chatgpt"] as const) {
      const result = LLMSchema.safeParse({
        default: { provider },
        profiles: {
          [profileName]: {
            source: "cloud",
            fallbackProfile: FALLBACK_PROFILE_BY_KEY[profileName],
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.path.join(".").endsWith("fallbackProfile"),
        );
        expect(issue?.message).toContain("cloud backup profile");
        expect(issue?.path).toEqual([
          "profiles",
          profileName,
          "fallbackProfile",
        ]);
      }
    }
  });

  test("z.toJSONSchema still generates for LLMSchema (config docs/routes)", () => {
    const json = z.toJSONSchema(LLMSchema, {
      unrepresentable: "any",
      io: "input",
    });
    // ProfileEntry carries a named meta id (#172), so zod v4 hoists it into
    // top-level $defs and the profiles record references it by $ref — the
    // fallbackProfile readOnly marker the docs surface lives in the $defs copy.
    expect(json).toMatchObject({
      properties: {
        profiles: {
          additionalProperties: { $ref: "#/$defs/ProfileEntry" },
        },
      },
      $defs: {
        ProfileEntry: {
          properties: { fallbackProfile: { readOnly: true } },
        },
      },
    });
  });
});

describe("LLMSchema backup profile references vs llm.default", () => {
  const backupKey = BACKUP_PROFILE_KEYS[0];
  const managed = { provider: "cadet" } as const;
  const nonManaged = [{ provider: "anthropic" }, { provider: "chatgpt" }];

  test("activeProfile naming a backup parses on the cloud column", () => {
    const result = LLMSchema.safeParse({
      default: managed,
      activeProfile: backupKey,
    });
    expect(result.success).toBe(true);
  });

  test("activeProfile naming a backup is rejected on a non-cloud column", () => {
    for (const blob of nonManaged) {
      const result = LLMSchema.safeParse({
        default: blob,
        activeProfile: backupKey,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "activeProfile",
        );
        expect(issue?.message).toContain("cloud backup profile");
      }
    }
  });

  test("advisorProfile naming a backup follows the same split", () => {
    expect(
      LLMSchema.safeParse({
        default: managed,
        advisorProfile: backupKey,
      }).success,
    ).toBe(true);
    for (const blob of nonManaged) {
      const result = LLMSchema.safeParse({
        default: blob,
        advisorProfile: backupKey,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) => i.path.join(".") === "advisorProfile",
          ),
        ).toBe(true);
      }
    }
  });

  test("a call-site pin on a backup follows the same split", () => {
    expect(
      LLMSchema.safeParse({
        default: managed,
        callSites: { recall: { profile: backupKey } },
      }).success,
    ).toBe(true);
    for (const blob of nonManaged) {
      const result = LLMSchema.safeParse({
        default: blob,
        callSites: { recall: { profile: backupKey } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "callSites.recall.profile",
        );
        expect(issue?.message).toContain("cloud backup profile");
      }
    }
  });

  test("a mix arm naming a backup follows the same split", () => {
    const mixConfig = (blob: { provider: string }) => ({
      default: blob,
      profiles: {
        armA: { speed: "fast" },
        blend: {
          mix: [
            { profile: backupKey, weight: 1 },
            { profile: "armA", weight: 1 },
          ],
        },
      },
    });
    expect(LLMSchema.safeParse(mixConfig(managed)).success).toBe(true);
    for (const blob of nonManaged) {
      expect(LLMSchema.safeParse(mixConfig(blob)).success).toBe(false);
    }
  });

  test("an absent blob or a non-matrix provider reads as the cloud column", () => {
    // An install predating the blob is managed by definition, so an absent
    // `default` keeps its backups referenceable. A provider value with no
    // matrix column (keyless ollama, user-endpoint openai-compatible) is
    // clamped to the cloud column at read time rather than failing the
    // blob. A non-string provider is NOT caught — the blob is a plain
    // fragment, so it fails the parse and the loader's leaf recovery strips
    // the bad leaf (covered by the loader tests).
    for (const blob of [undefined, { provider: "ollama" }]) {
      const result = LLMSchema.safeParse({
        default: blob,
        activeProfile: backupKey,
      });
      expect(result.success).toBe(true);
    }
    expect(
      LLMSchema.safeParse({
        default: { provider: 42 },
        activeProfile: backupKey,
      }).success,
    ).toBe(false);
  });

  test("the default profile keys stay valid on every column", () => {
    for (const blob of [managed, ...nonManaged]) {
      for (const key of DEFAULT_PROFILE_KEYS) {
        expect(
          LLMSchema.safeParse({ default: blob, activeProfile: key }).success,
        ).toBe(true);
      }
    }
  });

  // A managed install can persist a thin `{ source: "cloud" }` stub for a
  // backup key: `normalizeCloudProfileWrites` reduces a `config get` ->
  // `config set` echo of the effective profile list to exactly that. The stub
  // holds no body of its own, so it must not carry a reference past the
  // provider gate once the install moves off the cloud column.
  const stub = { source: "cloud" } as const;

  test("a cloud stub does not keep a backup reference alive off the cloud column", () => {
    for (const blob of nonManaged) {
      const result = LLMSchema.safeParse({
        default: blob,
        profiles: { [backupKey]: stub, primary: { effort: "high" } },
        activeProfile: backupKey,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "activeProfile",
        );
        expect(issue?.message).toContain("cloud backup profile");
      }
    }
  });

  test("a cloud stub does not keep a call-site pin or mix arm alive either", () => {
    for (const blob of nonManaged) {
      const callSitePin = LLMSchema.safeParse({
        default: blob,
        profiles: { [backupKey]: stub },
        callSites: { recall: { profile: backupKey } },
      });
      expect(callSitePin.success).toBe(false);

      const mixArm = LLMSchema.safeParse({
        default: blob,
        profiles: {
          [backupKey]: stub,
          armA: { speed: "fast" },
          blend: {
            mix: [
              { profile: backupKey, weight: 1 },
              { profile: "armA", weight: 1 },
            ],
          },
        },
      });
      expect(mixArm.success).toBe(false);
    }
  });

  test("a cloud stub does not keep a fallbackProfile pointer alive either", () => {
    for (const blob of nonManaged) {
      const result = LLMSchema.safeParse({
        default: blob,
        profiles: {
          [backupKey]: stub,
          primary: { fallbackProfile: backupKey },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.join(".") === "profiles.primary.fallbackProfile",
        );
        expect(issue?.message).toContain("Automatic fallbacks are code-owned");
      }
    }
  });

  test("a cloud stub keeps its references valid on the cloud column", () => {
    // The stub stands for a body that does resolve here, so nothing about it
    // makes the reference worse than the unmaterialized case.
    const result = LLMSchema.safeParse({
      default: managed,
      profiles: {
        [backupKey]: stub,
      },
      activeProfile: backupKey,
      callSites: { recall: { profile: backupKey } },
    });
    expect(result.success).toBe(true);
  });
});
