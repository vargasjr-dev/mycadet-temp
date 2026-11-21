"use client";

import { useState } from "react";

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      style={{
        background: "transparent",
        border: "1px solid #e2e1dc",
        borderRadius: 10,
        padding: "10px 14px",
        fontSize: 13,
        fontWeight: 600,
        color: copied ? "var(--green)" : "var(--ink)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
