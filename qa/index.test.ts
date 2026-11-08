import { describe, expect, test } from "bun:test";

import { buildCreateArgs, buildExecArgs, buildImagePushArgs } from "./index";

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
      "--memory",
      "4096",
    ]);
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
