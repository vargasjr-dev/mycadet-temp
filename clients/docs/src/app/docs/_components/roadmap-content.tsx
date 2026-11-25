import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import {
  readRoadmapFlow,
  RoadmapFlowView,
} from "@/app/docs/_components/roadmap-flow";

/**
 * The page's last-updated stamp is the roadmap markdown's last committed
 * date — git is the source of truth, nobody maintains this string. The
 * mtime fallback covers build contexts without a .git directory.
 */
function roadmapLastUpdated(): string {
  const committed = (() => {
    try {
      return execSync("git log -1 --format=%as -- clients/docs/src/content/roadmap.md", {
        cwd: path.join(process.cwd(), "..", ".."),
        encoding: "utf8",
      }).trim();
    } catch {
      return fs
        .statSync(path.join(process.cwd(), "src", "content", "roadmap.md"))
        .mtime.toISOString()
        .slice(0, 10);
    }
  })();
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(
    new Date(`${committed}T00:00:00`),
  );
}

export function RoadmapContent() {
  const flow = readRoadmapFlow();
  const tocItems = [
    { id: "the-plan", label: "The plan", level: 2 as const },
    ...flow.steps.map((step) => ({
      id: step.id,
      label: step.title,
      level: 2 as const,
    })),
  ];

  return (
    <>
      <DocsContent title="Roadmap" breadcrumb="Roadmap">
        <p className="mb-2 text-xs text-stone-400 dark:text-stone-500">
          Last updated {roadmapLastUpdated()}
        </p>

        <section id="the-plan">
          <SectionHeading id="the-plan" level={2}>
            The plan
          </SectionHeading>
          <RoadmapFlowView />
        </section>
      </DocsContent>
      <TableOfContents items={tocItems} />
    </>
  );
}
