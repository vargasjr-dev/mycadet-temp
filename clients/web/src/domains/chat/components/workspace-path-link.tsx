/**
 * Renders a code span that `rehypeWorkspacePath` flagged as a workspace file
 * path as a link — unconditionally, with no existence check.
 *
 * A path-shaped code span is not evidence of a file: the assistant writes
 * paths it is *about* to create, paths it has since deleted, and hypothetical
 * examples. The link used to confirm each path against a `workspace/tree`
 * listing of its parent directory (polled for a window after mount, to catch
 * announce-then-write spans) and underlined only confirmed hits. That cost
 * real traffic on every transcript render — one listing per distinct parent
 * directory, refetched while unresolved, and 404 storms for paths that could
 * never resolve (a span naming a directory that does not exist in the
 * workspace, or a repo-relative path in a multi-repo workspace). Rendering is
 * static; the check now happens at click time, where a stale path simply
 * opens the drawer on its not-found state — the same destination an explicit
 * link to a since-deleted file already hits.
 *
 * The existence question still has a home: the workspace browser's listings
 * (one recursive query) remain the place a user verifies what is actually
 * there.
 */

import { MARKDOWN_INLINE_CODE_CLASS } from "@mycadet/design-library";
import { useTranslation } from "@/i18n";
import {
  toCadetWorkspaceHref,
  workspaceBasenameOf,
} from "@/utils/workspace-path-links";

export interface WorkspacePathLinkProps {
  /** Workspace-relative path, set by `rehypeWorkspacePath`. */
  path?: string;
  /** The path exactly as the assistant wrote it — what the span displays. */
  raw?: string;
  /**
   * Where a click on the path goes, given its `cadet://` href and its
   * basename. The caller points this at the same destination an explicitly
   * linked file reaches, so the two affordances behave alike. Without it
   * there is no affordance to offer and the span stays plain code.
   */
  onOpen?: (href: string, linkText: string) => void;
}

export function WorkspacePathLink({ path, raw, onOpen }: WorkspacePathLinkProps) {
  const { t } = useTranslation("chat");
  const label = raw ?? path ?? "";

  if (!path || !onOpen) {
    return <code className={MARKDOWN_INLINE_CODE_CLASS}>{label}</code>;
  }

  return (
    <button
      type="button"
      onClick={() =>
        onOpen(toCadetWorkspaceHref(path), workspaceBasenameOf(path))
      }
      className={`${MARKDOWN_INLINE_CODE_CLASS} cursor-pointer text-[var(--system-positive-strong)] underline decoration-dotted underline-offset-2 hover:opacity-80`}
      title={t("workspacePathLink.openTitle", { path })}
    >
      {label}
    </button>
  );
}
