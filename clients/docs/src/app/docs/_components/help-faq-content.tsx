"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "about-privacy-and-data", label: "About privacy and data", level: 2 },
  {
    id: "about-the-assistant-itself",
    label: "About the assistant itself",
    level: 2,
  },
];

export function HelpFaqContent() {
  return (
    <>
      <DocsContent title="FAQ" breadcrumb="Docs / Help / FAQ">
        <p className="mb-8 text-zinc-600">
          Only the questions the rest of these docs don&apos;t answer live here.
          For everything else, ask your assistant — or read the docs.
        </p>

        <section id="about-privacy-and-data">
          <SectionHeading id="about-privacy-and-data" level={2}>
            About privacy and data
          </SectionHeading>

          <SectionHeading id="does-cadet-train-on-my-data" level={3}>
            Does Cadet train on my data?
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            No. From our side, your data is not used for training or
            fine-tuning. Anthropic&apos;s API terms also state that API data is
            not used for model training. We recommend reading{" "}
            <a href="https://www.anthropic.com/legal/privacy">
              Anthropic&apos;s Privacy Policy
            </a>{" "}
            directly for the most current details.
          </p>

          <SectionHeading id="does-cadet-collect-telemetry" level={3}>
            Does Cadet collect telemetry?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Only if you opt in. There are two optional toggles in Settings &gt;
            Privacy: usage analytics (anonymized token counts and feature
            adoption &mdash; no message content) and diagnostics consent (gates
            what the client may report about itself &mdash; no personal data).
            Both are off by default.
          </p>
        </section>

        <hr className="my-10 border-zinc-200" />

        <section id="about-the-assistant-itself">
          <SectionHeading id="about-the-assistant-itself" level={2}>
            About the assistant itself
          </SectionHeading>

          <SectionHeading id="does-it-have-feelings" level={3}>
            Does it have feelings?
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            No. It&apos;s very good at sounding like it does, though. Don&apos;t
            let the personality fool you. It&apos;s a language model with a good
            costume.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
