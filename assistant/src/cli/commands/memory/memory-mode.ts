/**
 * `assistant memory mode` — per-conversation memory-injection mode.
 *
 * The mode lives in the memory plugin's own store (the memory connection's
 * `conversation_memory_modes` table — see conversation-mode-store.ts), so the
 * CLI verbs route through the daemon's operator routes like every other
 * memory verb and the data stays plugin-owned.
 *
 *   - `get <conversationId>` — print the conversation's mode.
 *   - `set <conversationId> <standard|off>` — persist the mode. `off` means
 *     the plugin injects no memory for this conversation (no fresh retrieval
 *     of any engine, no static essentials/threads block, no PKB context).
 *   - `list` — every conversation with an explicit mode.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../../ipc/cli-client.js";
import type {
  ConversationModeGetResult,
  ConversationModeListResult,
  ConversationModeSetResult,
} from "../../../plugins/defaults/memory/src/memory-mode-routes.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";

function exitFromError(error: unknown): void {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function registerMemoryModeCommand(memory: Command): void {
  const mode = subcommand(memory, "mode");

  subcommand(mode, "get").action(
    async (conversationId: string, _opts: unknown, _cmd: Command) => {
      const result = await cliIpcCall<ConversationModeGetResult>(
        "memory_conversation_mode_get",
        { body: { conversationId } },
      );
      if (!result.ok) {
        return exitFromError(result.error ?? "Failed to read the mode");
      }
      const payload = result.result!;
      log.info(`${payload.conversationId}: ${payload.mode}`);
    },
  );

  subcommand(mode, "set").action(
    async (
      conversationId: string,
      value: string,
      _opts: unknown,
      _cmd: Command,
    ) => {
      if (value !== "standard" && value !== "off") {
        log.error(`Unknown mode "${value}" — expected "standard" or "off"`);
        process.exitCode = 1;
        return;
      }
      const result = await cliIpcCall<ConversationModeSetResult>(
        "memory_conversation_mode_set",
        { body: { conversationId, mode: value } },
      );
      if (!result.ok) {
        return exitFromError(result.error ?? "Failed to set the mode");
      }
      const payload = result.result!;
      if (!payload.ok) {
        log.error(
          `${payload.conversationId}: mode not persisted (memory database unavailable)`,
        );
        process.exitCode = 1;
        return;
      }
      log.info(`${payload.conversationId}: mode set to ${payload.mode}`);
    },
  );

  subcommand(mode, "list").action(async (_opts: unknown, _cmd: Command) => {
    const result = await cliIpcCall<ConversationModeListResult>(
      "memory_conversation_mode_list",
      { body: {} },
    );
    if (!result.ok) {
      return exitFromError(result.error ?? "Failed to list modes");
    }
    const modes = result.result!.modes;
    if (modes.length === 0) {
      log.info("No conversations with an explicit memory mode.");
      return;
    }
    for (const row of modes) {
      log.info(`${row.conversationId}: ${row.mode}`);
    }
  });
}
