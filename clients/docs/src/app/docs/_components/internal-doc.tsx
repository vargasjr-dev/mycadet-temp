import fs from "fs";
import path from "path";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { ReleaseMarkdown } from "@/app/docs/_components/release-markdown";

interface InternalDocProps {
  slug: string;
  title: string;
}

/**
 * Renders one of the repository's internal architecture docs (kept as plain
 * .md files under src/content/internals) inside the docs chrome. The read
 * happens at build time — these pages are static.
 */
export function InternalDoc({ slug, title }: InternalDocProps) {
  const md = fs.readFileSync(
    path.join(process.cwd(), "src", "content", "internals", `${slug}.md`),
    "utf8",
  );
  return (
    <DocsContent title={title} breadcrumb="Docs / Developer Guide / Internals">
      <ReleaseMarkdown content={md} />
    </DocsContent>
  );
}
