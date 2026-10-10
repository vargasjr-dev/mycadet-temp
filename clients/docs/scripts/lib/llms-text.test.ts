import { describe, expect, test } from "bun:test";

import { buildLlmsText } from "./llms-text";

describe("buildLlmsText", () => {
  test("lists pages sorted by route with .md URLs and descriptions", () => {
    const text = buildLlmsText([
      {
        route: "/docs/releases",
        title: "Releases",
        description: "Cadet releases",
      },
      {
        route: "/docs/getting-started",
        title: "Getting Started",
        description: "Install Cadet",
      },
    ]);

    const bullets = text
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(bullets).toEqual([
      "- [Getting Started](https://www.mycadet.ai/docs/getting-started.md): Install Cadet",
      "- [Releases](https://www.mycadet.ai/docs/releases.md): Cadet releases",
    ]);
  });

  test("maps the docs index route to index.md and omits empty descriptions", () => {
    const text = buildLlmsText([
      { route: "/docs", title: "Cadet Docs", description: "" },
    ]);

    expect(text).toContain("- [Cadet Docs](https://www.mycadet.ai/docs/index.md)");
    expect(text).not.toContain("index.md):");
  });

  test("starts with the header and ends with a single trailing newline", () => {
    const text = buildLlmsText([]);

    expect(text.startsWith("# Cadet Docs\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  test("throws for a route outside /docs", () => {
    expect(() =>
      buildLlmsText([{ route: "/blog/post", title: "Post", description: "" }]),
    ).toThrow("No markdown alternate path");
  });
});
