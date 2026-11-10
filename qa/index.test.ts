import { describe, expect, test } from "bun:test";

import {
  buildCreateArgs,
  buildExecArgs,
  buildImagePushArgs,
  buildQaLockfileSeed,
  buildVolumePushArgs,
  resolveVolumeRef,
} from "./index";

describe("buildImagePushArgs", () => {
  test("pushes the cadet-QA image from its own directory", () => {
    expect(buildImagePushArgs()).toEqual([
      "sandbox",
      "image",
      "push",
      "--name",
      "cadet-qa",
      "--dir",
      import.meta.dir,
      "--wait",
    ]);
  });

  test("--no-wait drops the wait flag", () => {
    expect(buildImagePushArgs({ wait: false })).not.toContain("--wait");
  });
});

describe("buildCreateArgs", () => {
  test("always pins the pushed QA image at the account-ceiling memory", () => {
    expect(buildCreateArgs({ name: "qa-desktop-1108" })).toEqual([
      "sandbox",
      "create",
      "--name",
      "qa-desktop-1108",
      "--image",
      "sandbox/cadet-qa:latest",
      "--volume",
      "cadet-qa:/qa",
      "--memory",
      "4096",
    ]);
  });
});

describe("the volume", () => {
  test("defaults to the cadet namespace, overridable by env or arg", () => {
    delete process.env.BASETEN_VOLUME_NAMESPACE;
    expect(resolveVolumeRef()).toBe("bdn:vargas-jr/cadet-qa:qa");
    process.env.BASETEN_VOLUME_NAMESPACE = "other-ns";
    try {
      expect(resolveVolumeRef()).toBe("bdn:other-ns/cadet-qa:qa");
    } finally {
      delete process.env.BASETEN_VOLUME_NAMESPACE;
    }
    expect(resolveVolumeRef("explicit-ns")).toBe("bdn:explicit-ns/cadet-qa:qa");
  });

  test("builds the push argv from a directory and ref", () => {
    expect(
      buildVolumePushArgs({ dir: "/tmp/qa-volume-x/qa", ref: "bdn:vargas-jr/cadet-qa:qa" }),
    ).toEqual(["volume", "push", "/tmp/qa-volume-x/qa", "bdn:vargas-jr/cadet-qa:qa"]);
  });

  test("the lockfile seed stamps the prebuilt dists at the app server's port", () => {
    const seed = JSON.parse(buildQaLockfileSeed("abc123"));
    expect(seed).toEqual({
      assistants: [],
      activeAssistant: null,
      app: { port: 7840, builtSha: "abc123" },
    });
  });
});

describe("buildExecArgs", () => {
  test("passes the command after the separator", () => {
    expect(
      buildExecArgs({ name: "qa-desktop-1108", command: ["sh", "-c", "true"] }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "qa-desktop-1108",
      "--",
      "sh",
      "-c",
      "true",
    ]);
  });
});
