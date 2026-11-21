import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "The Workspace | Cadet Docs",
  description:
    "Your assistant's brain is a folder — IDENTITY.md, SOUL.md, USER.md, NOW.md, and everything else in the workspace.",
  path: "/docs/key-concepts/the-workspace",
});

export default function TheWorkspacePage() {
  return (
    <MarkdownDoc
      file="key-concepts/the-workspace"
      title="The Workspace"
      breadcrumb="Docs / Key Concepts / The Workspace"
    />
  );
}
