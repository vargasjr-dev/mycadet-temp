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
const originalCadetWorkspaceDir = process.env.CADET_WORKSPACE_DIR;

let tempDir: string;
let workspaceDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-device-id-test-"));
  workspaceDir = join(tempDir, "workspace");
  delete process.env.CADET_DEVICE_ID;
  process.env.CADET_WORKSPACE_DIR = workspaceDir;
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
  if (originalCadetWorkspaceDir == null) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = originalCadetWorkspaceDir;
  }

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("getDeviceId workspace resolution", () => {
  test("writes device.json at the root of the workspace dir", () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "dev";

    const id = getDeviceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const expectedPath = join(workspaceDir, "device.json");
    expect(existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(parsed.deviceId).toBe(id);
  });

  test("environment name does not change the device.json location", () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.CADET_ENVIRONMENT = "no-such-env";

    getDeviceId();

    expect(existsSync(join(workspaceDir, "device.json"))).toBe(true);
    // No env-scoped directory is created anywhere else under tempDir.
    expect(readdirSync(tempDir)).toEqual(["workspace"]);
  });

  test("containerized mode writes device.json in the workspace too", () => {
    process.env.IS_CONTAINERIZED = "true";

    getDeviceId();

    expect(existsSync(join(workspaceDir, "device.json"))).toBe(true);
  });
});

describe("getDeviceId CADET_DEVICE_ID precedence", () => {
  test("env var set returns that value without writing device.json", () => {
    process.env.CADET_DEVICE_ID = "abc-123";

    expect(getDeviceId()).toBe("abc-123");
    // Nothing written anywhere under the temp workspace.
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("env var with surrounding whitespace returns the trimmed value", () => {
    process.env.CADET_DEVICE_ID = "  abc-123  ";

    expect(getDeviceId()).toBe("abc-123");
  });

  test("empty/whitespace-only env var falls through to file resolution", () => {
    process.env.CADET_DEVICE_ID = "   ";

    const id = getDeviceId();
    expect(id.length).toBeGreaterThan(0);
    expect(existsSync(join(workspaceDir, "device.json"))).toBe(true);
  });

  test("env var wins over an existing device.json without overwriting it", () => {
    mkdirSync(workspaceDir, { recursive: true });
    const filePath = join(workspaceDir, "device.json");
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
  test("returns null without creating device.json when no id exists", () => {
    const expectedPath = join(workspaceDir, "device.json");

    expect(getExistingDeviceId()).toBeNull();
    expect(existsSync(expectedPath)).toBe(false);
  });

  test("reads an existing device.json id", () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "device.json"),
      JSON.stringify({ deviceId: "file-id" }),
    );

    expect(getExistingDeviceId()).toBe("file-id");
  });

  test("returns the env override without writing device.json", () => {
    process.env.CADET_DEVICE_ID = "env-id";

    expect(getExistingDeviceId()).toBe("env-id");
    expect(existsSync(workspaceDir)).toBe(false);
  });
});
