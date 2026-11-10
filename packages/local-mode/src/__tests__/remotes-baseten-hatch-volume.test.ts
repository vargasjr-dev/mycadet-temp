import { afterEach, describe, expect, test } from "bun:test";

import {
  sandboxStateVolume,
  sandboxStateVolumeEnvs,
} from "../remotes/baseten/hatch";

const ENV = "BASETEN_SANDBOX_VOLUME";

afterEach(() => {
  delete process.env[ENV];
});

describe("sandboxStateVolume", () => {
  test("is unset without the env", () => {
    delete process.env[ENV];
    expect(sandboxStateVolume()).toBeUndefined();
  });

  test("a bare name mounts at /data", () => {
    process.env[ENV] = "cadet-assistant-state";
    expect(sandboxStateVolume()).toEqual({
      name: "cadet-assistant-state",
      mountPath: "/data",
    });
  });

  test("a NAME:PATH pair mounts at the given absolute path", () => {
    process.env[ENV] = "state:/mnt/volume";
    expect(sandboxStateVolume()).toEqual({
      name: "state",
      mountPath: "/mnt/volume",
    });
  });

  test("a relative mount path is refused", () => {
    process.env[ENV] = "state:mnt/volume";
    expect(() => sandboxStateVolume()).toThrow(/NAME:MOUNT_PATH/);
  });
});

describe("sandboxStateVolumeEnvs", () => {
  test("points both XDG homes into the volume", () => {
    expect(sandboxStateVolumeEnvs("/data")).toEqual([
      { name: "XDG_DATA_HOME", value: "/data/xdg-data", secret: false },
      { name: "XDG_CONFIG_HOME", value: "/data/xdg-config", secret: false },
    ]);
  });
});
