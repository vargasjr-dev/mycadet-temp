import fs from "fs";
import path from "path";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { ReleaseMarkdown } from "@/app/docs/_components/release-markdown";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import { extractMarkdownToc } from "@/lib/markdown-toc";

interface MarkdownDocProps {
  /** Path to the markdown file under `src/content/`, without the `.md` extension. */
  file: string;
  title: string;
  breadcrumb: string;
}

/**
 * Renders a markdown file from `src/content/` inside the docs chrome. The
 * read happens at build time — these pages are static. The markdown file is
 * the source of truth; this component only supplies the chrome.
 *
 * The table of contents is standard: it is extracted from the markdown's
 * own h2/h3 headings (anchored by rehype-slug in ReleaseMarkdown) and is
 * shown whenever the doc has two or more of them.
 */
export function MarkdownDoc({ file, title, breadcrumb }: MarkdownDocProps) {
  const md = fs.readFileSync(
    path.join(process.cwd(), "src", "content", `${file}.md`),
    "utf8",
  );
  const toc = extractMarkdownToc(md);
  return (
    <>
      <DocsContent title={title} breadcrumb={breadcrumb}>
        <ReleaseMarkdown content={md} />
      </DocsContent>
      {toc.length >= 2 ? <TableOfContents items={toc} /> : null}
    </>
  );
}
