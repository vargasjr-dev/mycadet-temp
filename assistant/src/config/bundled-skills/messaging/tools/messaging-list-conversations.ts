import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform =
    typeof input.platform === "string" ? input.platform : undefined;
  const types = Array.isArray(input.types)
    ? input.types.filter(
        (type) =>
          type === "channel" ||
          type === "dm" ||
          type === "group" ||
          type === "inbox",
      )
    : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;

  try {
    const provider = await resolveProvider(platform);
    const account =
      typeof input.account === "string" ? input.account : undefined;
    const conn = await getProviderConnection(provider, account);
    const conversations = await provider.listConversations(conn, {
      types,
      limit,
    });
    return ok(JSON.stringify(conversations, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
