"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let mermaidInitialized = false;
let mermaidModule: typeof mermaid | null = null;

async function getMermaid() {
  if (!mermaidModule) {
    mermaidModule = (await import("mermaid")).default;
  }
  if (!mermaidInitialized) {
    // `loose` is what allows `click <node> <href>` directives to render as
    // real links — that is the whole point for docs navigation.
    mermaidModule.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "default",
      flowchart: { htmlLabels: true },
    });
    mermaidInitialized = true;
  }
  return mermaidModule;
}

interface MermaidDiagramProps {
  code: string;
}

/**
 * Renders a ```mermaid fenced block. Falls back to the raw source in a
 * <pre> if rendering fails, so a bad diagram never blanks a docs page.
 */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef<string>(
    `mermaid-${Math.random().toString(36).slice(2, 10)}`,
  );

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    getMermaid()
      .then((m) => m.render(idRef.current, code))
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <pre className="my-4 overflow-x-auto rounded-lg bg-zinc-100 p-4 text-sm dark:bg-zinc-800">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="docs-mermaid my-4 overflow-x-auto [&_a]:underline [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      {...(svg
        ? { dangerouslySetInnerHTML: { __html: svg } }
        : { "aria-label": "Loading diagram" })}
    />
  );
}
