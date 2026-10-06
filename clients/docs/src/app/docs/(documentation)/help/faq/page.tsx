import { HelpFaqContent } from "@/app/docs/_components/help-faq-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "FAQ - Cadet Docs",
  description:
    "Frequently asked questions about Cadet — product capabilities, privacy, data handling, and your assistant.",
  path: "/docs/help/faq",
});

export default function HelpFaqPage() {
  return <HelpFaqContent />;
}
