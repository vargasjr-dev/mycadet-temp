import { describe, expect, test } from "bun:test";

import {
  BASETEN_STATE_VOLUME_MOUNT_PATH,
  BASETEN_STATE_VOLUME_NAME,
  sandboxStateVolumeEnvs,
} from "../remotes/baseten/hatch";

describe("the state volume constants", () => {
  test("the hatch's own volume name and mount", () => {
    expect(BASETEN_STATE_VOLUME_NAME).toBe("cadet-state");
    expect(BASETEN_STATE_VOLUME_MOUNT_PATH).toBe("/data");
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
