import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchConstitutionContent } from "@/lib/discover-docs-routes";
import { TableOfContents, TocItem } from "./table-of-contents";
import { ReactNode } from "react";

const labelToId = (label: string) =>
  label.toLowerCase().replace(/[ ]/g, "-").replace("--", "-").replace(".", "");

const isTocMarkdown = (children: ReactNode) =>
  typeof children === "object" &&
  !Array.isArray(children) &&
  children !== null &&
  "type" in children &&
  children.type === "a";

const Header = (level: 2 | 3): Components["h2"] | Components["h3"] =>
  function Header({ children }) {
    if (typeof children !== "string") {
      return children;
    }
    const id = labelToId(children);
    if (id === "table-of-contents") {
      return null;
    }

    const header = children.startsWith("Your Cadet is")
      ? children
          .split(" ")
          .map((word, index, all) =>
            index === all.length - 1 ? <i key={index}>{word}</i> : `${word} `,
          )
      : children;

    return (
      <SectionHeading id={id} level={level}>
        {header}
      </SectionHeading>
    );
  };

const COMPONENTS: Components = {
  h1: () => null,
  h2: Header(2),
  h3: Header(3),
  blockquote: ({ children }) => (
    <div className="mb-6 rounded-md border border-zinc-200 bg-zinc-50 px-5 pt-5 text-zinc-700">
      {children}
    </div>
  ),
  li: ({ children }) => {
    if (isTocMarkdown(children)) {
      return null;
    }
    return <li>{children}</li>;
  },
};

export default function ConstitutionMarkdown() {
  const content = fetchConstitutionContent();
  const tocItems = Array.from(content.matchAll(/(#+) ([A-Za-z\.\*_' -]+)/g))
    .map((match): TocItem => {
      const level = match[1];
      const label = match[2].replace(/_/g, "");
      const id = labelToId(label);
      return { id, label, level: level.length };
    })
    .filter((t) => t.level > 1);

  return (
    <>
      <style>
        {`#constitution ol > li {
  list-style: numbered;
}

#constitution ul > li { 
  list-style-type: disc;
}`}
      </style>
      <DocsContent
        id={"constitution"}
        title="Cadet Constitution"
        breadcrumb="Docs / Constitution"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
          {content}
        </ReactMarkdown>
      </DocsContent>
      <TableOfContents items={tocItems} />
    </>
  );
}
