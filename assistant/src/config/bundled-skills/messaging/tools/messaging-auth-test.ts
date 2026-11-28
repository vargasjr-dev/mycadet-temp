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

  try {
    const provider = await resolveProvider(platform);
    const account =
      typeof input.account === "string" ? input.account : undefined;
    const conn = await getProviderConnection(provider, account);
    const info = await provider.testConnection(conn);
    return ok(JSON.stringify(info, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
