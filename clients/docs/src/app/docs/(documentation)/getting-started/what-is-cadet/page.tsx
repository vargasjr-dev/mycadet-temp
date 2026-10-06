import { WhatIsCadetContent } from "@/app/docs/_components/what-is-cadet-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "What is Cadet? - Cadet Docs",
  description:
    "What is Cadet? A personal AI assistant with tools, memory, identity, and a private cloud workspace, different from ChatGPT or Claude.",
  path: "/docs/getting-started/what-is-cadet",
});

export default function WhatIsCadetPage() {
  return <WhatIsCadetContent />;
}
