import fs from "fs";
import path from "path";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { ReleaseMarkdown } from "@/app/docs/_components/release-markdown";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import { extractMarkdownToc } from "@/lib/markdown-toc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Vision | Cadet Docs",
  description:
    "The end state that we are building every Cadet and the ecosystem at large towards.",
  path: "/docs/vision",
});

export default function VisionPage() {
  // The repo root's VISION.md is the canonical source — the same root-file
  // pattern the Constitution and Glossary follow. The read happens at build
  // time; these pages are static.
  const md = fs
    .readFileSync(path.join(process.cwd(), "..", "..", "VISION.md"))
    .toString();
  const toc = extractMarkdownToc(md);

  return (
    <>
      <DocsContent title="Vision" breadcrumb="Docs / Vision">
        <ReleaseMarkdown content={md} />
      </DocsContent>
      {toc.length >= 2 ? <TableOfContents items={toc} /> : null}
    </>
  );
}
