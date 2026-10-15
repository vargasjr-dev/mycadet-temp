import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppShell } from "../dist/package/index.js";
import { AssistantResolutionSchema } from "../dist/package/contracts.js";

if (typeof window !== "undefined") {
  throw new Error("Package verification must run without a browser.");
}
if (
  !readFileSync(
    new URL("../dist/package/index.js", import.meta.url),
    "utf8",
  ).startsWith('"use client";')
) {
  throw new Error("The app entry must preserve its client boundary.");
}
AssistantResolutionSchema.parse({ status: "empty" });
let requested = false;
const html = renderToString(
  createElement(AppShell, {
    resolveAssistant: async () => {
      requested = true;
      return { status: "empty" };
    },
    location: "/admin/assistant",
    mountPath: "/admin/assistant",
    origin: "https://site.example.com",
    onNavigate: () => {
      throw new Error("SSR must not navigate.");
    },
  }),
);
if (requested || !html.includes("Loading assistant")) {
  throw new Error("SSR must render the shell without starting resolution.");
}
console.log("Portable app package passed server-render verification.");
