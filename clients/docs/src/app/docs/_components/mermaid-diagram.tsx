"use client";

import { useEffect, useId, useState } from "react";
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
  // State records which `code` it belongs to, so a render for a new diagram
  // resets by derivation — no synchronous setState inside the effect, which
  // the react-compiler flags as a cascading-render hazard.
  const [rendered, setRendered] = useState<{ code: string; svg: string } | null>(
    null,
  );
  const [failedFor, setFailedFor] = useState<string | null>(null);
  // A pure per-instance id (useId) instead of Math.random at render time;
  // mermaid rejects the colon-shaped default, so strip to [A-Za-z0-9-].
  const id = useId().replace(/[^a-zA-Z0-9-]/g, "");

  useEffect(() => {
    let cancelled = false;
    getMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) {
          setRendered({ code, svg: renderedSvg });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailedFor(code);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  const svg = rendered?.code === code ? rendered.svg : null;
  const failed = failedFor === code;

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
