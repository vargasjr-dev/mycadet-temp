import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { isAbortLikeError } from "../../../../tools/shared/abort.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform =
    typeof input.platform === "string" ? input.platform : undefined;
  const conversationId = input.conversation_id;
  const messageId =
    typeof input.message_id === "string" ? input.message_id : undefined;

  if (typeof conversationId !== "string" || !conversationId) {
    return err("conversation_id is required.");
  }
  throwIfCancelled(context);

  try {
    const provider = await resolveProvider(platform);
    if (!provider.markRead) {
      return err(
        `${provider.displayName} does not support marking messages as read.`,
      );
    }
    const account =
      typeof input.account === "string" ? input.account : undefined;
    const conn = await getProviderConnection(provider, account);
    // Recheck: provider resolution and the connection lookup are awaits, and a
    // cancel landing in either must not still mutate the mailbox.
    throwIfCancelled(context);
    await provider.markRead(conn, conversationId, messageId);
    return ok("Marked as read.");
  } catch (e) {
    // A cancelled turn is not a mark-read failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(e)) {
      throw e;
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}
