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
  const types = input.types as string[] | undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;

  try {
    const provider = await resolveProvider(platform);
    const account =
      typeof input.account === "string" ? input.account : undefined;
    const conn = await getProviderConnection(provider, account);
    const conversations = await provider.listConversations(conn, {
      types: types as Array<"channel" | "dm" | "group" | "inbox"> | undefined,
      limit,
    });
    return ok(JSON.stringify(conversations, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
