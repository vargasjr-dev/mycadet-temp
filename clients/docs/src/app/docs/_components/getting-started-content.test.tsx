/**
 * `/docs/getting-started` is one combined document — what Cadet is,
 * installation, quick start, and your first skill. These tests lock the
 * public install matrix facts (iOS, Android, macOS, Windows, web, self-host,
 * no shipped Linux desktop client) against the markdown source itself.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { extractMarkdownToc } from "@/lib/markdown-toc";

const md = readFileSync(
  path.join(process.cwd(), "src", "content", "getting-started.md"),
  "utf8",
);

describe("getting-started.md", () => {
  test("names the shipped mobile clients and store listings", () => {
    expect(md).toContain("Android app");
    expect(md).toContain("Google Play");
    expect(md).toContain(
      "play.google.com/store/apps/details?id=ai.mycadet.android",
    );
    expect(md).toContain("App Store");
    expect(md).toContain("apps.apple.com/us/app/mycadet/id6759934423");
  });

  test("points desktop install at the public downloads page", () => {
    expect(md).toContain("mycadet.ai/downloads");
    expect(md).toContain("Desktop app (macOS and Windows)");
  });

  test("states there is no shipped Linux desktop client", () => {
    expect(md).toContain("no shipped Linux desktop client");
    expect(md).toContain("Self-host the assistant runtime");
    expect(md).not.toContain("no shipped Windows");
  });

  test("extracts a table of contents that matches its own headings", () => {
    const toc = extractMarkdownToc(md);
    expect(toc.length).toBeGreaterThanOrEqual(2);
    const ids = toc.map((item) => item.id);
    expect(ids).toContain("installation");
    expect(ids).toContain("linux");
    // Fence-aware: the ~/.cadet directory sample must not leak headings.
    expect(ids).not.toContain("lockfilejson");
    for (const item of toc) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
