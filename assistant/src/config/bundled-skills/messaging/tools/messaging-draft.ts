import {
  createDraft,
  deleteDraft,
  listDrafts,
} from "../../../../messaging/draft-store.js";
import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;

  switch (action) {
    case "create": {
      const platform =
        typeof input.platform === "string" ? input.platform : undefined;
      const conversationId =
        typeof input.conversation_id === "string"
          ? input.conversation_id
          : undefined;
      const text = typeof input.text === "string" ? input.text : undefined;

      if (!platform) {
        return err("platform is required for creating a draft.");
      }
      if (!conversationId) {
        return err("conversation_id is required for creating a draft.");
      }
      if (!text) {
        return err("text is required for creating a draft.");
      }

      throwIfCancelled(context);
      const draft = createDraft({
        platform,
        conversationId,
        text,
        threadId:
          typeof input.thread_id === "string" ? input.thread_id : undefined,
        subject: typeof input.subject === "string" ? input.subject : undefined,
      });
      return ok(`Draft created (ID: ${draft.id}). Stored locally for review.`);
    }

    case "list": {
      const platform =
        typeof input.platform === "string" ? input.platform : undefined;
      if (!platform) {
        return err("platform is required for listing drafts.");
      }
      const drafts = listDrafts(platform);
      if (drafts.length === 0) {
        return ok("No drafts found.");
      }
      return ok(JSON.stringify(drafts, null, 2));
    }

    case "delete": {
      const draftId =
        typeof input.draft_id === "string" ? input.draft_id : undefined;
      const platform =
        typeof input.platform === "string" ? input.platform : undefined;
      if (!draftId) {
        return err("draft_id is required for deleting a draft.");
      }
      if (!platform) {
        return err("platform is required for deleting a draft.");
      }
      throwIfCancelled(context);
      const deleted = deleteDraft(platform, draftId);
      if (!deleted) {
        return err("Draft not found.");
      }
      return ok("Draft deleted.");
    }

    default:
      return err(
        `Unknown action "${action}". Use "create", "list", or "delete".`,
      );
  }
}
