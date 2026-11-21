"use client";

import { useEffect, useState } from "react";

const PHRASES = ["email", "projects", "routines", "business"];
// ~1s per word, every word — no long hold on the last one (his call): the
// rotation runs at a steady beat straight through the loop.
const STEP_MS = 1000;
const EXIT_MS = 600;

export default function Silhouette() {
  const [index, setIndex] = useState(0);
  const [exiting, setExiting] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setExiting(index);
      setIndex((index + 1) % PHRASES.length);
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [index]);

  useEffect(() => {
    if (exiting === null) {
      return;
    }
    const t = setTimeout(() => setExiting(null), EXIT_MS);
    return () => clearTimeout(t);
  }, [exiting]);

  return (
    <span className="silhouette">
      {exiting !== null && (
        <span key={`out-${exiting}`} aria-hidden className="silhouette-out">
          {PHRASES[exiting]}
        </span>
      )}
      <span key={`in-${index}`} className="silhouette-in">
        {PHRASES[index]}
      </span>
    </span>
  );
}
