"use client";

import { useRef } from "react";
import { previewUnlocked, setPreviewUnlocked } from "@/lib/preview";

/**
 * The hero title doubles as the knock for the secret preview mode: seven
 * consecutive clicks (each within a beat and a half of the last) unlock
 * the gated landing sections for this tab, seven more lock them again.
 * Deliberately ZERO visual feedback — it's a secret; the only tell is the
 * gated section itself appearing.
 */

const KNOCKS = 7;
const GAP_MS = 1500;

export function PreviewTitle() {
  const taps = useRef(0);
  const last = useRef(0);

  const knock = () => {
    const now = Date.now();
    taps.current = now - last.current <= GAP_MS ? taps.current + 1 : 1;
    last.current = now;
    if (taps.current >= KNOCKS) {
      taps.current = 0;
      setPreviewUnlocked(!previewUnlocked());
    }
  };

  return (
    <h1 className="hero-title" onClick={knock}>
      Cadet
    </h1>
  );
}
