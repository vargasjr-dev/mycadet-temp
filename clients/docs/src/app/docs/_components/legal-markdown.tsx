import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchLegalPageContent } from "@/lib/discover-docs-routes";
import { TableOfContents, TocItem } from "./table-of-contents";

const labelToId = (label: string) =>
  label.toLowerCase().replace(/[ ]/g, "-").replace("--", "-").replace(".", "");

// Headings become anchored SectionHeadings; the component derives the TOC
// from the markdown itself, so a copy edit that adds a section updates the
// outline for free.
const COMPONENTS: Components = {
  h1: () => null,
  h2: ({ children }) => {
    if (typeof children !== "string") {return children;}
    return (
      <SectionHeading id={labelToId(children)} level={2}>
        {children}
      </SectionHeading>
    );
  },
  h3: ({ children }) => {
    if (typeof children !== "string") {return children;}
    return (
      <SectionHeading id={labelToId(children)} level={3}>
        {children}
      </SectionHeading>
    );
  },
};

export default function LegalMarkdown({
  file,
  title,
  breadcrumb,
}: {
  file: string;
  title: string;
  breadcrumb: string;
}) {
  const content = fetchLegalPageContent(file);
  const tocItems = Array.from(
    content.matchAll(/(#+) ([A-Za-z0-9\.\*_'&;\/ -]+)/g),
  )
    .map((match): TocItem => {
      const level = match[1];
      const label = match[2].trim();
      return { id: labelToId(label), label, level: level.length };
    })
    .filter((t) => t.level > 1);

  return (
    <>
      <DocsContent title={title} breadcrumb={breadcrumb}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
          {content}
        </ReactMarkdown>
      </DocsContent>
      <TableOfContents items={tocItems} />
    </>
  );
}
