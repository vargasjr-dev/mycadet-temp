import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Agentic Payments - Cadet Docs",
  description:
    "How your assistant pays for things on your behalf through your Link account, with every purchase capped at an amount you approve.",
  path: "/docs/key-concepts/agentic-payments",
});

export default function AgenticPaymentsPage() {
  return (
    <MarkdownDoc
      file="key-concepts/agentic-payments"
      title="Agentic Payments"
      breadcrumb="Docs / Key Concepts / Agentic Payments"
    />
  );
}
