import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  environmentFromVersion,
  getCurrentEnvironment,
  getSeed,
} from "../resolve.js";

const ENV_VARS_TO_SAVE = [
  "CADET_ENVIRONMENT",
  "CADET_PLATFORM_URL",
  "CADET_ASSISTANT_PLATFORM_URL",
  "CADET_LOCKFILE_DIR",
] as const;

describe("getCurrentEnvironment", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_VARS_TO_SAVE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("returns production seed when no override, no env var", () => {
    const env = getCurrentEnvironment();
    expect(env.name).toBe("production");
    expect(env.platformUrl).toBe("https://cloud.mycadet.ai");
  });

  test("returns dev seed when CADET_ENVIRONMENT=dev", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const env = getCurrentEnvironment();
    expect(env.name).toBe("dev");
    expect(env.platformUrl).toBe("https://dev-cloud.mycadet.ai");
  });

  test("returns staging seed when CADET_ENVIRONMENT=staging", () => {
    process.env.CADET_ENVIRONMENT = "staging";
    expect(getCurrentEnvironment().platformUrl).toBe(
      "https://staging-cloud.mycadet.ai",
    );
  });

  test("returns local seed with localhost URL", () => {
    process.env.CADET_ENVIRONMENT = "local";
    expect(getCurrentEnvironment().platformUrl).toBe("http://localhost:8000");
  });

  test("override argument takes priority over CADET_ENVIRONMENT env var", () => {
    process.env.CADET_ENVIRONMENT = "staging";
    const env = getCurrentEnvironment("dev");
    expect(env.name).toBe("dev");
    expect(env.platformUrl).toBe("https://dev-cloud.mycadet.ai");
  });

  test("empty override argument falls through to env var", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const env = getCurrentEnvironment("");
    expect(env.name).toBe("dev");
  });

  test("whitespace-only override argument falls through to env var", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const env = getCurrentEnvironment("   ");
    expect(env.name).toBe("dev");
  });

  test("falls back to production seed for unknown env name via override, warns on stderr", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const env = getCurrentEnvironment("no-such-env");
      expect(env.name).toBe("production");
      expect(env.platformUrl).toBe("https://cloud.mycadet.ai");
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('unknown environment "no-such-env"'),
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('falling back to "production"'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("falls back to production seed for unknown env name via env var, warns on stderr", () => {
    process.env.CADET_ENVIRONMENT = "nope";
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const env = getCurrentEnvironment();
      expect(env.name).toBe("production");
      expect(env.platformUrl).toBe("https://cloud.mycadet.ai");
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('unknown environment "nope"'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("CADET_ENVIRONMENT=production does not emit a warning", () => {
    process.env.CADET_ENVIRONMENT = "production";
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const env = getCurrentEnvironment();
      expect(env.name).toBe("production");
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  test("CADET_PLATFORM_URL overrides platformUrl on the resolved definition", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.CADET_PLATFORM_URL = "https://custom.example.com";
    const env = getCurrentEnvironment();
    expect(env.name).toBe("dev");
    expect(env.platformUrl).toBe("https://custom.example.com");
  });

  test("CADET_PLATFORM_URL override does not affect the seed table", () => {
    process.env.CADET_PLATFORM_URL = "https://custom.example.com";
    getCurrentEnvironment();
    delete process.env.CADET_PLATFORM_URL;
    const env = getCurrentEnvironment();
    expect(env.platformUrl).toBe("https://cloud.mycadet.ai");
  });

  test("CADET_ASSISTANT_PLATFORM_URL overrides assistantPlatformUrl", () => {
    process.env.CADET_ASSISTANT_PLATFORM_URL =
      "http://host.docker.internal:8000";
    const env = getCurrentEnvironment();
    expect(env.assistantPlatformUrl).toBe("http://host.docker.internal:8000");
  });

  test("CADET_ASSISTANT_PLATFORM_URL does not shadow platformUrl", () => {
    process.env.CADET_ASSISTANT_PLATFORM_URL = "http://override";
    const env = getCurrentEnvironment();
    expect(env.platformUrl).toBe("https://cloud.mycadet.ai");
  });

  test("does not auto-materialize a new environment from CADET_PLATFORM_URL alone", () => {
    // Unknown env names fall back to production (parity with daemon + Swift).
    // The per-field CADET_PLATFORM_URL override is intentionally dropped on
    // the fallback path — fallback returns a pristine production seed so a
    // typo'd env var can't accidentally stitch together a new environment.
    process.env.CADET_ENVIRONMENT = "my-custom";
    process.env.CADET_PLATFORM_URL = "https://my-custom.example.com";
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const env = getCurrentEnvironment();
      expect(env.name).toBe("production");
      expect(env.platformUrl).toBe("https://cloud.mycadet.ai");
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('unknown environment "my-custom"'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("CADET_LOCKFILE_DIR populates lockfileDirOverride on the resolved definition", () => {
    process.env.CADET_LOCKFILE_DIR = "/tmp/test-lockfile-dir";
    const env = getCurrentEnvironment();
    expect(env.lockfileDirOverride).toBe("/tmp/test-lockfile-dir");
  });

  test("lockfileDirOverride is undefined when CADET_LOCKFILE_DIR is unset", () => {
    const env = getCurrentEnvironment();
    expect(env.lockfileDirOverride).toBeUndefined();
  });

  test("lockfileDirOverride applies to non-prod envs too", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.CADET_LOCKFILE_DIR = "/tmp/test-lockfile-dir";
    const env = getCurrentEnvironment();
    expect(env.name).toBe("dev");
    expect(env.lockfileDirOverride).toBe("/tmp/test-lockfile-dir");
  });
});

describe("environmentFromVersion", () => {
  test("dev-release versions map to dev", () => {
    expect(environmentFromVersion("0.12.6-dev.202610081023.3a27b77")).toBe(
      "dev",
    );
    expect(environmentFromVersion("v0.12.6-dev.202610081023.3a27b77")).toBe(
      "dev",
    );
  });

  test("staging versions map to staging", () => {
    expect(environmentFromVersion("0.6.0-staging.3")).toBe("staging");
  });

  test("local build versions map to local", () => {
    expect(environmentFromVersion("0.12.6-local.42")).toBe("local");
  });

  test("stable versions map to production", () => {
    expect(environmentFromVersion("0.12.6")).toBe("production");
    expect(environmentFromVersion("v0.12.6")).toBe("production");
  });

  test("an empty version string maps to production", () => {
    expect(environmentFromVersion("")).toBe("production");
  });
});

describe("getSeed", () => {
  test("returns a definition for a known seed", () => {
    const seed = getSeed("dev");
    expect(seed).toBeDefined();
    expect(seed?.name).toBe("dev");
    expect(seed?.platformUrl).toBe("https://dev-cloud.mycadet.ai");
  });

  test("returns undefined for an unknown name", () => {
    expect(getSeed("no-such-env")).toBeUndefined();
  });

  test("returned seed is a copy — mutations do not affect the table", () => {
    const seed = getSeed("dev");
    if (seed) {
      seed.platformUrl = "mutated";
    }
    const second = getSeed("dev");
    expect(second?.platformUrl).toBe("https://dev-cloud.mycadet.ai");
  });

  test("all five canonical seeds exist", () => {
    expect(getSeed("production")).toBeDefined();
    expect(getSeed("staging")).toBeDefined();
    expect(getSeed("test")).toBeDefined();
    expect(getSeed("dev")).toBeDefined();
    expect(getSeed("local")).toBeDefined();
  });
});
