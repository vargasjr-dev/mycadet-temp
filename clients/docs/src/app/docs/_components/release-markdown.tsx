"use client";

import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import { MermaidDiagram } from "@/app/docs/_components/mermaid-diagram";
import { DocsVideo } from "@/app/docs/_components/docs-video";
import { DOCS_VIDEOS, type DocsVideoSlug } from "@/lib/docs/videos";
import { navCardsFromList } from "@/lib/nav-cards";

interface ReleaseMarkdownProps {
  content: string;
  /**
   * Render the page's plain-markdown jump list (link + em-dash description
   * per item) as `.docs-nav-cards` markup. Opt-in per page; the markdown
   * source stays a plain list either way.
   */
  navCards?: boolean;
}

export function ReleaseMarkdown({
  content,
  navCards = false,
}: ReleaseMarkdownProps) {
  return (
    <div className="[&_h3]:mt-6 [&_h3]:mb-3 [&_h3]:text-xl [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_li]:mb-1.5 [&_li]:leading-relaxed [&_p]:mb-3 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm dark:[&_code]:bg-zinc-800">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSlug]}
        components={{
          ul({ node, children, ...props }) {
            const cards = navCards && node ? navCardsFromList(node) : null;
            if (cards) {
              return (
                <div className="docs-nav-cards">
                  {cards.map((card) => (
                    <a
                      key={card.href}
                      href={card.href}
                      className="docs-nav-card"
                    >
                      <div className="docs-nav-card-content">
                        <span className="docs-nav-card-title">
                          {card.title}
                        </span>
                        <span className="docs-nav-card-desc">{card.desc}</span>
                      </div>
                      <span className="docs-nav-card-arrow" aria-hidden="true">
                        →
                      </span>
                    </a>
                  ))}
                </div>
              );
            }
            return <ul {...props}>{children}</ul>;
          },
          code({ className, children, ...props }) {
            if (/language-mermaid\b/.test(className ?? "")) {
              return (
                <MermaidDiagram code={String(children).replace(/\n$/, "")} />
              );
            }
            if (/language-docs-video\b/.test(className ?? "")) {
              const slug = String(children).trim() as DocsVideoSlug;
              if (slug in DOCS_VIDEOS) return <DocsVideo video={slug} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
