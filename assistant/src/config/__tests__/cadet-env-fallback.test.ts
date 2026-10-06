import { afterEach, describe, expect, test } from "bun:test";

import {
  checkUnrecognizedEnvVars,
  getDisablePlatform,
  readEnv,
} from "../env-registry.js";

// Snapshot/restore (never delete) — the bunfig preload seeds process env
// (e.g. VELLUM_WORKSPACE_DIR) for the whole test process; wiping shared vars
// would break every test file that runs after this one.
const savedEnv = new Map<string, string | undefined>();
const remember = (key: string) => {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
};
const setEnv = (key: string, value: string | undefined) => {
  remember(key);
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
});

describe("readEnv rebrand fallback rule", () => {
  test("legacy VELLUM_* applies when no CADET_* is set", () => {
    setEnv("VELLUM_WORKSPACE_DIR", "/legacy/workspace");
    setEnv("CADET_WORKSPACE_DIR", undefined);
    expect(readEnv("VELLUM_WORKSPACE_DIR")).toBe("/legacy/workspace");
  });

  test("CADET_* is primary when both are set", () => {
    setEnv("VELLUM_WORKSPACE_DIR", "/legacy/workspace");
    setEnv("CADET_WORKSPACE_DIR", "/cadet/workspace");
    expect(readEnv("VELLUM_WORKSPACE_DIR")).toBe("/cadet/workspace");
  });

  test("CADET_* alone wins", () => {
    setEnv("VELLUM_WORKSPACE_DIR", undefined);
    setEnv("CADET_WORKSPACE_DIR", "/cadet/workspace");
    expect(readEnv("VELLUM_WORKSPACE_DIR")).toBe("/cadet/workspace");
  });

  test("empty CADET_* falls through to the legacy value", () => {
    setEnv("VELLUM_WORKSPACE_DIR", "/legacy/workspace");
    setEnv("CADET_WORKSPACE_DIR", "   ");
    expect(readEnv("VELLUM_WORKSPACE_DIR")).toBe("/legacy/workspace");
  });

  test("unset vars return undefined", () => {
    setEnv("VELLUM_WORKSPACE_DIR", undefined);
    setEnv("CADET_WORKSPACE_DIR", undefined);
    expect(readEnv("VELLUM_WORKSPACE_DIR")).toBeUndefined();
  });

  test("non-VELLUM-prefixed names are read as-is (no CADET_ mapping)", () => {
    setEnv("GATEWAY_PORT", "7123");
    expect(readEnv("GATEWAY_PORT")).toBe("7123");
    expect(readEnv("CADET_GATEWAY_PORT")).toBeUndefined();
  });

  test("typed accessors inherit the rule (flag)", () => {
    setEnv("VELLUM_DISABLE_PLATFORM", undefined);
    setEnv("CADET_DISABLE_PLATFORM", "true");
    expect(getDisablePlatform()).toBe(true);
  });

  test("checkUnrecognizedEnvVars accepts CADET_* spellings of known vars", () => {
    setEnv("CADET_WORKSPACE_DIR", "/cadet/workspace");
    expect(
      checkUnrecognizedEnvVars().some((w) => w.includes("CADET_WORKSPACE_DIR")),
    ).toBe(false);
  });

  test("checkUnrecognizedEnvVars still flags truly unknown CADET_*/VELLUM_* vars", () => {
    setEnv("CADET_TOTALLY_UNKNOWN_VAR", "1");
    setEnv("VELLUM_TOTALLY_UNKNOWN_VAR", "1");
    const warnings = checkUnrecognizedEnvVars();
    expect(warnings.some((w) => w.includes("CADET_TOTALLY_UNKNOWN_VAR"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("VELLUM_TOTALLY_UNKNOWN_VAR"))).toBe(
      true,
    );
  });
});
