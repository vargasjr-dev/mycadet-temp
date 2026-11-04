import { describe, expect, test } from "bun:test";

import { pullImage } from "../remotes/docker/hatch";

describe("pullImage", () => {
  function fakePull(
    opts: {
      failFirstPullWith?: string;
      failAllPullsWith?: string;
    } = {},
  ) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let pulls = 0;
    const exec = async (cmd: string, args: string[] = []): Promise<void> => {
      calls.push({ cmd, args });
      if (cmd === "docker" && args[0] === "pull") {
        pulls++;
        if (opts.failAllPullsWith) throw new Error(opts.failAllPullsWith);
        if (opts.failFirstPullWith && pulls === 1) {
          throw new Error(opts.failFirstPullWith);
        }
      }
      // `docker logout` (and anything else) succeeds silently.
    };
    const ran = (sub: string): boolean =>
      calls.some((c) => c.cmd === "docker" && c.args[0] === sub);
    return { exec, ran };
  }

  test("pulls without touching stored credentials on success", async () => {
    const { exec, ran } = fakePull();

    await pullImage("mycadet/mycadet-assistant:v1", () => {}, exec);

    expect(ran("pull")).toBe(true);
    expect(ran("logout")).toBe(false);
  });

  test("clears stale Docker Hub credentials and retries once on an expired-token error", async () => {
    const { exec, ran } = fakePull({
      failFirstPullWith:
        "Error response from daemon: authentication required - personal access token is expired",
    });

    await pullImage("mycadet/mycadet-assistant:v1", () => {}, exec);

    expect(ran("logout")).toBe(true);
  });

  test("wraps the failure with actionable copy when the auth retry also fails", () => {
    const { exec } = fakePull({
      failAllPullsWith:
        "Error response from daemon: authentication required - personal access token is expired",
    });

    expect(
      pullImage("mycadet/mycadet-assistant:v1", () => {}, exec),
    ).rejects.toThrow("Failed to pull mycadet/mycadet-assistant:v1");
  });

  test("rethrows non-auth pull errors raw and never logs out", () => {
    const { exec, ran } = fakePull({
      failAllPullsWith:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    });

    expect(
      pullImage("mycadet/mycadet-assistant:v1", () => {}, exec),
    ).rejects.toThrow("Cannot connect to the Docker daemon");
    expect(ran("logout")).toBe(false);
  });
});
