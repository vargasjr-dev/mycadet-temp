import { afterAll, describe, expect, mock, test } from "bun:test";

import {
  classifyProcess,
  detectOrphanedProcesses,
  isInteractiveCliSession,
} from "./orphan-detection.js";

// `mock.restore()` does not undo `mock.module()`; keep the real module so it
// can be restored in afterAll for later test files in the same run.
const realStepRunner = { ...(await import("./step-runner")) };

describe("isInteractiveCliSession", () => {
  test("matches a live tunnel session launched via a script path", () => {
    expect(
      isInteractiveCliSession(
        "bun /Users/x/.nvm/versions/node/v22.14.0/bin/cadet tunnel --provider ngrok",
      ),
    ).toBe(true);
  });

  test("matches interactive subcommands like logs and terminal", () => {
    expect(isInteractiveCliSession("cadet logs foo")).toBe(true);
    expect(isInteractiveCliSession("cadet terminal")).toBe(true);
  });

  test("matches the other long-running interactive subcommands", () => {
    expect(isInteractiveCliSession("cadet events")).toBe(true);
    expect(isInteractiveCliSession("cadet client")).toBe(true);
    expect(isInteractiveCliSession("cadet ssh quiet-finch")).toBe(true);
    expect(isInteractiveCliSession("cadet message quiet-finch hi")).toBe(true);
    expect(isInteractiveCliSession("cadet workflows")).toBe(true);
    expect(isInteractiveCliSession("cadet-cli tunnel --provider ngrok")).toBe(
      true,
    );
  });

  test("allows the known global flags before the subcommand", () => {
    expect(isInteractiveCliSession("cadet --plain tunnel")).toBe(true);
    expect(isInteractiveCliSession("cadet --no-color logs foo")).toBe(true);
    expect(isInteractiveCliSession("cadet --no-color --plain events")).toBe(
      true,
    );
  });

  test("matches exec sessions even when argv mentions a service name", () => {
    expect(
      isInteractiveCliSession(
        "cadet exec -it --service cadet-gateway -- /bin/sh",
      ),
    ).toBe(true);
  });

  test("does not match non-interactive CLI wrappers", () => {
    expect(isInteractiveCliSession("cadet hatch")).toBe(false);
    expect(isInteractiveCliSession("/usr/bin/cadet sleep")).toBe(false);
    expect(isInteractiveCliSession("cadet wake")).toBe(false);
    expect(isInteractiveCliSession("cadet wake --watch")).toBe(false);
  });

  test("matches the implicit TUI client (bare cadet)", () => {
    expect(isInteractiveCliSession("cadet")).toBe(true);
    expect(isInteractiveCliSession("bun /Users/x/.nvm/bin/cadet")).toBe(true);
    expect(isInteractiveCliSession("cadet --plain")).toBe(true);
  });

  test("matches a foreground wake session", () => {
    expect(isInteractiveCliSession("cadet wake --foreground")).toBe(true);
    expect(isInteractiveCliSession("cadet wake --watch --foreground")).toBe(
      true,
    );
    expect(
      isInteractiveCliSession("bun /Users/x/bin/cadet wake --foreground"),
    ).toBe(true);
  });

  test("interactive names in later argv tokens do not match", () => {
    expect(isInteractiveCliSession("cadet hatch --name logs")).toBe(false);
    expect(isInteractiveCliSession("cadet sleep logs")).toBe(false);
  });

  test("unknown flags before the subcommand do not match", () => {
    expect(isInteractiveCliSession("cadet --verbose tunnel")).toBe(false);
  });

  test("repo paths containing cadet do not match", () => {
    expect(
      isInteractiveCliSession(
        "node /Users/runner/work/vellum-assistant/vellum-assistant/scripts/build.js",
      ),
    ).toBe(false);
  });
});

describe("classifyProcess", () => {
  test("labels interactive CLI sessions as cadet like any other wrapper", () => {
    expect(classifyProcess("cadet tunnel --provider ngrok")).toBe("cadet");
    expect(classifyProcess("cadet logs foo")).toBe("cadet");
    expect(classifyProcess("cadet-cli tunnel --provider ngrok")).toBe("cadet");
  });

  test("classifies non-interactive CLI wrappers as cadet", () => {
    expect(classifyProcess("cadet hatch")).toBe("cadet");
    expect(classifyProcess("cadet")).toBe("cadet");
    expect(classifyProcess("/usr/bin/cadet sleep")).toBe("cadet");
    expect(classifyProcess("cadet hatch --name logs")).toBe("cadet");
    expect(classifyProcess("cadet sleep logs")).toBe("cadet");
  });

  test("service process classifications are unchanged", () => {
    expect(classifyProcess("/opt/homebrew/bin/qdrant --config foo")).toBe(
      "qdrant",
    );
    expect(classifyProcess("bun /x/bin/cadet-gateway --port 7830")).toBe(
      "gateway",
    );
    expect(classifyProcess("bun /x/bin/cadet-daemon start")).toBe("assistant");
    expect(classifyProcess("node daemon start")).toBe("assistant");
    expect(
      classifyProcess("bun /x/bin/cadet-openclaw-adapter --port 9000"),
    ).toBe("openclaw-adapter");
  });

  test("macOS desktop app processes stay excluded", () => {
    expect(
      classifyProcess("/Applications/Vellum.app/Contents/MacOS/Vellum"),
    ).toBe("unknown");
  });

  test("repo paths containing cadet do not match", () => {
    expect(
      classifyProcess(
        "node /Users/runner/work/vellum-assistant/vellum-assistant/scripts/build.js",
      ),
    ).toBe("unknown");
  });
});

describe("detectOrphanedProcesses", () => {
  afterAll(() => {
    mock.module("./step-runner", () => realStepRunner);
  });

  test("skips live interactive sessions but still reports orphaned services", async () => {
    const psOutput = [
      "101 1 bun /Users/x/bin/cadet tunnel --provider ngrok",
      "102 1 cadet exec -it --service cadet-gateway -- /bin/sh",
      "103 1 cadet --plain logs foo",
      "104 1 bun /x/bin/cadet-gateway --port 7830",
      "105 1 cadet hatch",
      "106 1 node /opt/unrelated-service/daemon/main.ts",
      "107 1 node ./tools daemon start",
      "108 1 node /opt/CADET/daemon/main.ts",
    ].join("\n");
    mock.module("./step-runner", () => ({
      ...realStepRunner,
      execOutput: async () => psOutput,
    }));

    const orphans = await detectOrphanedProcesses({
      excludePids: new Set<string>(),
    });

    expect(orphans.map((o) => o.pid).sort()).toEqual(["104", "105"]);
    expect(orphans.find((o) => o.pid === "104")?.name).toBe("gateway");
    expect(orphans.find((o) => o.pid === "105")?.name).toBe("cadet");
  });
});
