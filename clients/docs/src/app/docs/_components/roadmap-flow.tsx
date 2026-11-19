import fs from "fs";
import path from "path";

import { ReleaseMarkdown } from "./release-markdown";

export interface RoadmapFlowStep {
  title: string;
  body: string;
  id: string;
}

export interface RoadmapFlow {
  intro: string;
  steps: RoadmapFlowStep[];
}

export function slugifyStepTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse the roadmap markdown into an intro block and an ordered list of
 * flow steps. A step is a `## Title` heading followed by body text; the
 * intro is everything before the first `## ` (minus the `# ` title line).
 * The markdown file is the source of truth — this only shapes it.
 */
export function parseRoadmapFlow(md: string): RoadmapFlow {
  const withoutH1 = md.replace(/^# .*\n/, "");
  const firstSection = withoutH1.indexOf("\n## ");
  const intro = (
    firstSection === -1 ? withoutH1 : withoutH1.slice(0, firstSection + 1)
  ).trim();
  const stepsBody =
    firstSection === -1 ? "" : withoutH1.slice(firstSection + 1);

  const steps: RoadmapFlowStep[] = [];
  for (const chunk of stepsBody.split(/^## /m)) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }
    const newline = trimmed.indexOf("\n");
    const title = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
    const body = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
    steps.push({ title, body, id: slugifyStepTitle(title) });
  }
  return { intro, steps };
}

function readRoadmapMarkdown(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src", "content", "roadmap.md"),
    "utf8",
  );
}

export function readRoadmapFlow(): RoadmapFlow {
  return parseRoadmapFlow(readRoadmapMarkdown());
}

/**
 * Render the roadmap markdown as a vertical flow — a numbered timeline
 * where each step is a card hanging off a connecting spine. Content lives
 * in `src/content/roadmap.md`; edit there, this shapes it.
 */
export function RoadmapFlowView() {
  const flow = readRoadmapFlow();
  return (
    <>
      <ReleaseMarkdown content={flow.intro} />
      <ol className="relative m-0 list-none border-l border-stone-200 pl-0 dark:border-moss-600/50">
        {flow.steps.map((step, index) => (
          <li key={step.id} id={step.id} className="relative py-5 pl-10">
            <span className="absolute left-0 top-7 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-stone-300 bg-white text-xs font-medium text-stone-600 dark:border-moss-600 dark:bg-zinc-900 dark:text-stone-300">
              {index + 1}
            </span>
            <h3 className="mb-2 mt-0 font-sans text-lg font-semibold text-stone-900 dark:text-stone-100">
              {step.title}
            </h3>
            <ReleaseMarkdown content={step.body} />
          </li>
        ))}
      </ol>
    </>
  );
}
