import { describe, expect, test } from "bun:test";

import { parseRoadmapFlow, slugifyStepTitle } from "./roadmap-flow";

describe("parseRoadmapFlow", () => {
  test("a leading status word becomes the step's chip, not its title", () => {
    const flow = parseRoadmapFlow(
      ["# Roadmap", "", "intro", "", "## Release Migrate from Vellum", "", "body."].join(
        "\n",
      ),
    );
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]!.status).toBe("Release");
    expect(flow.steps[0]!.title).toBe("Migrate from Vellum");
    expect(flow.steps[0]!.id).toBe("migrate-from-vellum");
  });

  test("plain headings keep their whole title (a leading verb is not a chip)", () => {
    const flow = parseRoadmapFlow(
      ["# Roadmap", "## Launch the mobile apps", "", "body."].join("\n"),
    );
    expect(flow.steps[0]!.status).toBeNull();
    expect(flow.steps[0]!.title).toBe("Launch the mobile apps");
  });

  test("unknown leading words are titles, not chips", () => {
    const flow = parseRoadmapFlow(
      ["# Roadmap", "## Launch Cadet Cloud", "", "body."].join("\n"),
    );
    expect(flow.steps[0]!.status).toBeNull();
  });

  test("the intro collects everything before the first step", () => {
    const flow = parseRoadmapFlow(
      ["# Roadmap", "", "bridge text", "", "## A step", "", "body."].join("\n"),
    );
    expect(flow.intro).toContain("bridge text");
    expect(flow.intro).not.toContain("# Roadmap");
  });

  test("slugifyStepTitle lowercases and dashes", () => {
    expect(slugifyStepTitle("Launch the mobile apps")).toBe(
      "launch-the-mobile-apps",
    );
  });
});
