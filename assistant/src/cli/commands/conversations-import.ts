import { existsSync, readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { isPlainObject } from "../../util/object.js";
import { readStdinSync } from "../../util/read-stdin.js";
import { subcommand } from "../lib/cli-command-help.js";
import { log } from "../logger.js";

// -- Import payload schema (local, no daemon imports) --

interface ImportPayload {
  conversations: Record<string, unknown>[];
}

interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  messages: number;
  errors: Array<{
    index: number;
    sourceKey?: string;
    error: string;
  }>;
}

// -- Validation (pure logic, no daemon imports) --

function validatePayload(raw: unknown): ImportPayload {
  if (!isPlainObject(raw)) {
    throw new Error("Input must be a JSON object with a 'conversations' array");
  }
  const obj = raw;
  if (!Array.isArray(obj.conversations)) {
    throw new Error("Input must have a 'conversations' array");
  }
  const conversations = obj.conversations.map((conv: unknown, i) => {
    if (!isPlainObject(conv) || !conv.title || typeof conv.title !== "string") {
      throw new Error(
        `conversations[${i}].title is required and must be a string`,
      );
    }
    if (!Array.isArray(conv.messages) || conv.messages.length === 0) {
      throw new Error(`conversations[${i}].messages must be a non-empty array`);
    }
    for (let j = 0; j < conv.messages.length; j++) {
      const msg: unknown = conv.messages[j];
      if (!isPlainObject(msg) || !msg.role || typeof msg.role !== "string") {
        throw new Error(`conversations[${i}].messages[${j}].role is required`);
      }
      if (msg.content === undefined || msg.content === null) {
        throw new Error(
          `conversations[${i}].messages[${j}].content is required`,
        );
      }
    }
    return conv;
  });
  return { conversations };
}

// -- CLI registration --

export function registerConversationsImportCommand(
  conversations: Command,
): void {
  subcommand(conversations, "import").action(
    async (opts: { file?: string; json?: boolean }) => {
      let raw: string;
      try {
        if (opts.file) {
          if (!existsSync(opts.file)) {
            throw new Error(`File not found: ${opts.file}`);
          }
          raw = readFileSync(opts.file, "utf-8");
        } else {
          if (process.stdin.isTTY) {
            throw new Error(
              "No input provided. Pipe JSON into stdin or use --file <path>.",
            );
          }
          raw = readStdinSync();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      let payload: ImportPayload;
      try {
        const parsed = JSON.parse(raw);
        payload = validatePayload(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      if (payload.conversations.length === 0) {
        const result = { ok: true, imported: 0, skipped: 0, messages: 0 };
        if (opts.json) {
          log.info(JSON.stringify(result));
        } else {
          log.info("No conversations to import.");
        }
        return;
      }

      const r = await cliIpcCall<ImportResult>("conversations_import", {
        body: {
          conversations: payload.conversations,
        },
      });
      if (!r.ok) {
        return exitFromIpcResult(r);
      }

      const result = r.result!;
      if (opts.json) {
        log.info(JSON.stringify(result));
      } else {
        const lines = [
          `Imported ${result.imported} conversation(s) with ${result.messages} message(s).`,
        ];
        if (result.skipped > 0) {
          lines.push(
            `Skipped ${result.skipped} already-imported conversation(s).`,
          );
        }
        if (result.errors.length > 0) {
          lines.push(`Failed: ${result.errors.length} conversation(s).`);
        }
        log.info(lines.join("\n"));
      }
    },
  );
}
