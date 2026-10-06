import { HelpCommonIssuesContent } from "@/app/docs/_components/help-common-issues-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Common Issues - Cadet Docs",
  description:
    "Troubleshoot common Cadet issues — installation, permissions, skills, performance, and workspace problems.",
  path: "/docs/help/common-issues",
});

export default function HelpCommonIssuesPage() {
  return <HelpCommonIssuesContent />;
}
