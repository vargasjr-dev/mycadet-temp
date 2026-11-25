import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";

export function ArchitectureNorthStarContent() {
  return (
    <DocsContent
      title="North star"
      breadcrumb="Docs / Architecture / North star"
    >
      <p className="mb-4 text-stone-600 dark:text-stone-400">
        Cadet&apos;s north star is a two-machine architecture: one hardened core
        that thinks, remembers, schedules, and holds every key — and one
        disposable workbench where your assistant experiments, holding nothing
        precious.
      </p>
      <p className="mb-8 text-stone-600 dark:text-stone-400">
        The worst thing that can happen inside the workbench is losing the
        workbench. This page will carry the full north-star narrative and an
        interactive diagram; for now, the path there lives on the{" "}
        <a
          href="/roadmap"
          className="text-stone-900 underline dark:text-stone-100"
        >
          roadmap
        </a>
        .
      </p>

      <section id="the-core">
        <SectionHeading id="the-core" level={2}>
          The core
        </SectionHeading>
        <p className="mb-4 text-stone-600 dark:text-stone-400">
          Coming soon — the loop, memory, scheduler, credential broker, and the
          plugin patch protocol, and why they belong together behind one trust
          boundary.
        </p>
      </section>

      <section id="the-workbench">
        <SectionHeading id="the-workbench" level={2}>
          The workbench
        </SectionHeading>
        <p className="mb-0 text-stone-600 dark:text-stone-400">
          Coming soon — the disposable execution plane: what runs there, what it
          must never hold, and how it stays replaceable.
        </p>
      </section>
    </DocsContent>
  );
}
