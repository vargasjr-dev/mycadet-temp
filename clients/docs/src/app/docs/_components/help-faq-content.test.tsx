/**
 * The FAQ only holds questions the rest of the docs don't answer. Any
 * question with a backing doc was removed as redundant — people have agents
 * to ask questions.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HelpFaqContent } from "@/app/docs/_components/help-faq-content";

const html = renderToStaticMarkup(<HelpFaqContent />);

describe("HelpFaqContent", () => {
  test("keeps only the answers no doc backs", () => {
    expect(html).toContain("Does Cadet collect telemetry?");
    expect(html).toContain("Does Cadet train on my data?");
    expect(html).toContain("Does it have feelings?");
  });

  test("no longer answers questions the docs already cover", () => {
    expect(html).not.toContain("What is Cadet?");
    expect(html).not.toContain("Is Cadet free?");
    expect(html).not.toContain("What platforms does it support?");
    expect(html).not.toContain("Can it send emails as me?");
    expect(html).not.toContain("Is there a Windows app?");
  });

  test("links no internal docs page", () => {
    expect(html).not.toContain('href="/docs/');
  });
});
