import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import {
  readRoadmapFlow,
  RoadmapFlowView,
} from "@/app/docs/_components/roadmap-flow";

export function RoadmapContent() {
  const flow = readRoadmapFlow();
  const tocItems = [
    { id: "the-plan", label: "The plan", level: 2 as const },
    ...flow.steps.map((step) => ({
      id: step.id,
      label: step.title,
      level: 2 as const,
    })),
    { id: "the-fine-print", label: "The fine print", level: 2 as const },
  ];

  return (
    <>
      <DocsContent title="Roadmap" breadcrumb="Docs / Roadmap">
        <p className="mb-2 text-xs text-stone-400 dark:text-stone-500">
          Last updated November 19, 2026
        </p>
        <p className="mb-8 text-stone-600 dark:text-stone-400">
          This roadmap is the bridge between{" "}
          <a
            href="/docs/architecture"
            className="text-stone-900 underline dark:text-stone-100"
          >
            today&apos;s architecture
          </a>{" "}
          and the{" "}
          <a
            href="/docs/vision"
            className="text-stone-900 underline dark:text-stone-100"
          >
            north star
          </a>{" "}
          — the plan for getting from one to the other, in order.
        </p>

        <section id="the-plan">
          <SectionHeading id="the-plan" level={2}>
            The plan
          </SectionHeading>
          <RoadmapFlowView />
        </section>

        <section id="the-fine-print" className="mt-12">
          <SectionHeading id="the-fine-print" level={2}>
            The fine print
          </SectionHeading>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Polish, bug fixes, and security improvements are a standing
            commitment — a meaningful slice of every team&apos;s capacity goes
            here, always. That work doesn&apos;t show up on this page, but it
            ships continuously.
          </p>
          <p className="mb-4 text-stone-600 dark:text-stone-400">
            Priorities shift. Steps will merge, split, or get dropped — this
            page changes with us. If there&apos;s something you want to see
            sooner, tell us — we read every note.
          </p>
          <p className="mb-0 text-stone-600 dark:text-stone-400">
            Want to share feedback on our Roadmap? Drop us a note in{" "}
            <a
              href="https://discord.com/invite/ZABd9V2zM8"
              target="_blank"
              rel="noopener noreferrer"
            >
              Discord
            </a>
            .
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={tocItems} />
    </>
  );
}
