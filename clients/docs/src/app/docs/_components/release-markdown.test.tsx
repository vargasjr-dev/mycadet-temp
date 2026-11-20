/**
 * The homepage's jumping-off list is plain markdown — a link plus an em-dash
 * description per item. With `navCards` on, ReleaseMarkdown renders that
 * shape as `.docs-nav-cards` markup; any other list stays a list.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ReleaseMarkdown } from "@/app/docs/_components/release-markdown";

const LIST = `- [Getting Started](/docs/getting-started) — Install, set up, and go.
- [Roadmap](/docs/roadmap) — What's shipping soon.
`;

describe("ReleaseMarkdown navCards", () => {
  test("renders a link + em-dash list as docs nav cards", () => {
    const html = renderToStaticMarkup(
      <ReleaseMarkdown navCards content={LIST} />,
    );
    expect(html).toContain("docs-nav-cards");
    expect(html).toContain('href="/docs/getting-started"');
    expect(html).toContain("docs-nav-card-title");
    expect(html).toContain("Getting Started");
    expect(html).toContain("Install, set up, and go.");
    expect(html).not.toContain("<ul");
  });

  test("keeps a normal list when navCards is off", () => {
    const html = renderToStaticMarkup(<ReleaseMarkdown content={LIST} />);
    expect(html).toContain("<ul");
    expect(html).not.toContain("docs-nav-cards");
  });

  test("keeps a normal list for items that are not link + description", () => {
    const html = renderToStaticMarkup(
      <ReleaseMarkdown navCards content={"- plain item\n- another\n"} />,
    );
    expect(html).toContain("<ul");
    expect(html).not.toContain("docs-nav-cards");
  });
});
