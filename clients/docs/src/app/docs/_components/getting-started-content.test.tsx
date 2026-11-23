/**
 * `/docs/getting-started` is Vargas's revised short page: Setup (cloud sign
 * up, downloads, self-host CLI install), Updates, and a Where-to-go-next
 * jump list that renders as docs nav cards. These tests pin that shape
 * against the markdown source itself, and guard against the TODO comments
 * he left during the revision creeping back in.
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
  test("keeps Vargas's revision: Setup, Updates, Where to go next", () => {
    expect(md).toContain("## Setup");
    expect(md).toContain("## Updates");
    expect(md).toContain("## Where to go next");
    expect(md).not.toContain("## Installation");
  });

  test("covers cloud sign up, downloads, and the self-host CLI install", () => {
    expect(md).toContain("https://mycadet.ai/account/signup");
    expect(md).toContain("/downloads");
    expect(md).toContain("npm install -g @mycadet/cli");
  });

  test("carries no unresolved revision TODOs", () => {
    expect(md).not.toContain("TODO:");
    expect(md).not.toContain("<!--");
  });

  test("bare markdown h2s are styled by the theme, not reset by preflight", () => {
    const css = readFileSync(
      path.join(process.cwd(), "src", "app", "docs", "docs-theme.css"),
      "utf8",
    );
    // The rule must exist inside @layer base...
    expect(css).toContain(".docs-shell .docs-prose h2 {");
    // ...without a zero-specificity wrapper, which loses to Tailwind v4's
    // preflight (h2 { font-size: inherit }) in the same layer and renders
    // markdown headings as normal text.
    expect(css).not.toContain(":where(.docs-shell .docs-prose h2)");
  });

  test("Where to go next uses the nav-cards list shape", () => {
    expect(md).toContain(
      "- [Key Concepts](/docs/key-concepts/the-workspace) —",
    );
    expect(md).toContain("- [Plugins](/docs/extensibility) —");
    expect(md).not.toContain("/docs/key-concepts)");
  });

  test("extracts a table of contents that matches its own headings", () => {
    const toc = extractMarkdownToc(md);
    expect(toc.map((item) => item.label)).toEqual([
      "Setup",
      "Updates",
      "Where to go next",
    ]);
  });
});
