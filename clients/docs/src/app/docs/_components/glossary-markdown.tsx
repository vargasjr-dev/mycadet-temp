import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import { fetchGlossaryContent } from "@/lib/discover-docs-routes";

const TOC_ITEMS = [{ id: "terms", label: "Terms", level: 2 }];

interface GlossaryEntry {
  term: string;
  paragraphs: string[];
}

/**
 * The root GLOSSARY.md is the canonical source (if the two diverge, it wins).
 * This parses its `### Term` sections into the zebra table below — the md
 * file is the only place terms are maintained.
 */
function parseGlossary(content: string): {
  intro: string;
  entries: GlossaryEntry[];
} {
  const [before = "", after = ""] = content.split(/^---$/m);
  const introParagraph = before
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim() !== "")[0];

  const entries: GlossaryEntry[] = [];
  for (const section of after.split(/^### /m).slice(1)) {
    const [termLine, ...rest] = section.split("\n");
    const term = termLine.trim();
    const paragraphs = rest
      .join("\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (term && paragraphs.length > 0) {
      entries.push({ term, paragraphs });
    }
  }
  return { intro: introParagraph, entries };
}

function Definition({ paragraphs }: { paragraphs: string[] }) {
  return (
    <>
      {paragraphs.map((text, i) => (
        <span
          key={i}
          className={i < paragraphs.length - 1 ? "mb-3 block" : "block"}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: "span" }}>
            {text}
          </ReactMarkdown>
        </span>
      ))}
    </>
  );
}

export default function GlossaryMarkdown() {
  const { intro, entries } = parseGlossary(fetchGlossaryContent());

  return (
    <>
      <DocsContent title="Glossary" breadcrumb="Docs / Key Concepts / Glossary">
        <p className="mb-6 text-zinc-600">{intro}</p>

        <section id="terms" className="mb-8">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Term
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    Definition
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                {entries.map((entry) => (
                  <tr key={entry.term}>
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      <strong>{entry.term}</strong>
                    </td>
                    <td className="px-3 py-2">
                      <Definition paragraphs={entry.paragraphs} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
