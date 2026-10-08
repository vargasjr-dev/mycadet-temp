import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getDeviceId,
  getExistingDeviceId,
  resetDeviceIdCache,
} from "../util/device-id.js";

const originalCadetEnvironment = process.env.CADET_ENVIRONMENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalIsContainerized = process.env.IS_CONTAINERIZED;
const originalCadetDeviceId = process.env.CADET_DEVICE_ID;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-device-id-test-"));
  delete process.env.CADET_DEVICE_ID;
  resetDeviceIdCache();
});

afterEach(() => {
  resetDeviceIdCache();

  if (originalCadetEnvironment == null) {
    delete process.env.CADET_ENVIRONMENT;
  } else {
    process.env.CADET_ENVIRONMENT = originalCadetEnvironment;
  }
  if (originalXdgConfigHome == null) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalIsContainerized == null) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalIsContainerized;
  }
  if (originalCadetDeviceId == null) {
    delete process.env.CADET_DEVICE_ID;
  } else {
    process.env.CADET_DEVICE_ID = originalCadetDeviceId;
  }

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("getDeviceId env-awareness", () => {
  test("non-prod (dev) writes device.json under $XDG_CONFIG_HOME/cadet-dev", () => {
    // Guarantee we're not containerized — the test-preload deletes this,
    // but be defensive.
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = tempDir;

    const id = getDeviceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const expectedPath = join(tempDir, "cadet-dev", "device.json");
    expect(existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(parsed.deviceId).toBe(id);
  });

  test("staging environment writes under $XDG_CONFIG_HOME/cadet-staging", () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "staging";
    process.env.XDG_CONFIG_HOME = tempDir;

    getDeviceId();

    const expectedPath = join(tempDir, "cadet-staging", "device.json");
    expect(existsSync(expectedPath)).toBe(true);
  });

  test("unknown environment falls back to $XDG_CONFIG_HOME/cadet", () => {
    // Unknown env names resolve to the production-shaped XDG config dir.
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "no-such-env";
    process.env.XDG_CONFIG_HOME = tempDir;

    getDeviceId();

    const productionXdgPath = join(tempDir, "cadet", "device.json");
    expect(existsSync(productionXdgPath)).toBe(true);
    // No env-scoped dir is created for the unknown name.
    const envScopedPath = join(tempDir, "cadet-no-such-env", "device.json");
    expect(existsSync(envScopedPath)).toBe(false);
  });

  test("production writes under $XDG_CONFIG_HOME/cadet", () => {
    // device.json lives in the env-scoped XDG config directory for every
    // non-containerized environment.
    delete process.env.IS_CONTAINERIZED;
    delete process.env.CADET_ENVIRONMENT;
    process.env.XDG_CONFIG_HOME = tempDir;

    getDeviceId();

    const xdgPath = join(tempDir, "cadet", "device.json");
    expect(existsSync(xdgPath)).toBe(true);
  });
});

describe("getDeviceId CADET_DEVICE_ID precedence", () => {
  beforeEach(() => {
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  test("env var set returns that value without writing device.json", () => {
    process.env.CADET_DEVICE_ID = "abc-123";

    expect(getDeviceId()).toBe("abc-123");
    // Nothing written anywhere under the XDG tempdir.
    expect(readdirSync(tempDir)).toEqual([]);
  });

  test("env var with surrounding whitespace returns the trimmed value", () => {
    process.env.CADET_DEVICE_ID = "  abc-123  ";

    expect(getDeviceId()).toBe("abc-123");
  });

  test("empty/whitespace-only env var falls through to file resolution", () => {
    process.env.CADET_DEVICE_ID = "   ";

    const id = getDeviceId();
    expect(id.length).toBeGreaterThan(0);
    expect(existsSync(join(tempDir, "cadet-dev", "device.json"))).toBe(true);
  });

  test("env var wins over an existing device.json without overwriting it", () => {
    const dir = join(tempDir, "cadet-dev");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "device.json");
    writeFileSync(filePath, JSON.stringify({ deviceId: "file-id" }));
    process.env.CADET_DEVICE_ID = "env-id";

    expect(getDeviceId()).toBe("env-id");
    expect(JSON.parse(readFileSync(filePath, "utf-8")).deviceId).toBe(
      "file-id",
    );
  });

  test("env-resolved value stays cached until resetDeviceIdCache", () => {
    process.env.CADET_DEVICE_ID = "env-id";
    expect(getDeviceId()).toBe("env-id");

    delete process.env.CADET_DEVICE_ID;
    expect(getDeviceId()).toBe("env-id");

    resetDeviceIdCache();
    expect(getDeviceId()).not.toBe("env-id");
  });
});

describe("getExistingDeviceId", () => {
  beforeEach(() => {
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  test("returns null without creating device.json when no id exists", () => {
    const expectedPath = join(tempDir, "cadet-dev", "device.json");

    expect(getExistingDeviceId()).toBeNull();
    expect(existsSync(expectedPath)).toBe(false);
  });

  test("reads an existing device.json id", () => {
    const dir = join(tempDir, "cadet-dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "device.json"),
      JSON.stringify({ deviceId: "file-id" }),
    );

    expect(getExistingDeviceId()).toBe("file-id");
  });

  test("returns the env override without writing device.json", () => {
    process.env.CADET_DEVICE_ID = "env-id";

    expect(getExistingDeviceId()).toBe("env-id");
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
