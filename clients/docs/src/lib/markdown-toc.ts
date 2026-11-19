import GithubSlugger from "github-slugger";

import type { TocItem } from "@/app/docs/_components/table-of-contents";

/**
 * Extracts the h2/h3 headings from a markdown document as TOC items.
 *
 * Fence-aware (``` blocks are skipped — mermaid and code samples never
 * contribute headings) and id-compatible with `rehype-slug`, which is what
 * `ReleaseMarkdown` uses to anchor headings: both slug the rendered text
 * via github-slugger, so a TOC entry and its heading anchor always match.
 */
export function extractMarkdownToc(md: string): TocItem[] {
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  let inFence = false;

  for (const line of md.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const label = match[2]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*`]/g, "")
      .trim();
    items.push({
      id: slugger.slug(label),
      label,
      level: match[1].length,
    });
  }

  return items;
}
