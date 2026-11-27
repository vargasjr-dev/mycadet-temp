import type { Message } from "../../../../messaging/provider-types.js";
import { wrapUntrustedContent } from "../../../../security/untrusted-content.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

function wrapMessageContent(msg: Message): Message {
  const source =
    msg.platform === "gmail" || msg.platform === "outlook" ? "email" : "slack";
  return {
    ...msg,
    text: wrapUntrustedContent(msg.text, {
      source,
      sourceDetail: msg.sender.email ?? msg.sender.name,
    }),
  };
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform =
    typeof input.platform === "string" ? input.platform : undefined;
  const conversationId = input.conversation_id;
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  const threadId =
    typeof input.thread_id === "string" ? input.thread_id : undefined;

  if (typeof conversationId !== "string" || !conversationId) {
    return err("conversation_id is required.");
  }

  try {
    const provider = await resolveProvider(platform);
    const account =
      typeof input.account === "string" ? input.account : undefined;
    const conn = await getProviderConnection(provider, account);
    let messages;
    if (threadId && provider.getThreadReplies) {
      messages = await provider.getThreadReplies(
        conn,
        conversationId,
        threadId,
        { limit },
      );
    } else {
      messages = await provider.getHistory(conn, conversationId, { limit });
    }
    return ok(JSON.stringify(messages.map(wrapMessageContent), null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
