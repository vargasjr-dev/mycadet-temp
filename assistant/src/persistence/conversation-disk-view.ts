/**
 * Write-through disk view for conversations.
 *
 * Projects conversation metadata, messages, and attachments to a browsable
 * filesystem layout under $CADET_WORKSPACE_DIR/conversations/. This enables
 * the assistant to search/read/manipulate conversation data using standard
 * file tools.
 *
 * All disk writes are best-effort — failures are logged but never thrown,
 * so the disk view cannot break DB operations.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import {
  getAttachmentContent,
  getAttachmentMetadataForMessage,
  getFilePathForAttachment,
} from "./attachments-store.js";
import {
  getConversation,
  getMessageById,
  getMessages,
} from "./conversation-crud.js";
import {
  getConversationDirName,
  getConversationDirPath,
  getLegacyConversationDirPath,
  getResolvedConversationDirPath,
} from "./conversation-directories.js";

const log = getLogger("conversation-disk-view");

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export { getConversationDirName, getConversationDirPath };

function ensureConversationDirPath(id: string, createdAtMs: number): string {
  const dirPath = getResolvedConversationDirPath(id, createdAtMs);
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create the conversation directory and write the initial meta.json.
 */
export function initConversationDir(conv: {
  id: string;
  title: string | null;
  createdAt: number;
  conversationType: string;
  originChannel: string | null;
}): void {
  try {
    const dirPath = ensureConversationDirPath(conv.id, conv.createdAt);

    const meta = {
      id: conv.id,
      title: conv.title,
      type: conv.conversationType,
      channel: conv.originChannel,
      createdAt: new Date(conv.createdAt).toISOString(),
      updatedAt: new Date(conv.createdAt).toISOString(),
    };

    writeFileSync(
      join(dirPath, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );
  } catch (err) {
    log.warn(
      { err, conversationId: conv.id },
      "Failed to init conversation dir",
    );
  }
}

/**
 * Rewrite meta.json with updated fields.
 */
export function updateMetaFile(conv: {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  conversationType: string;
  originChannel: string | null;
}): void {
  try {
    const dirPath = ensureConversationDirPath(conv.id, conv.createdAt);

    const meta = {
      id: conv.id,
      title: conv.title,
      type: conv.conversationType,
      channel: conv.originChannel,
      createdAt: new Date(conv.createdAt).toISOString(),
      updatedAt: new Date(conv.updatedAt).toISOString(),
    };

    writeFileSync(
      join(dirPath, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );
  } catch (err) {
    log.warn({ err, conversationId: conv.id }, "Failed to update meta file");
  }
}

// ---------------------------------------------------------------------------
// Content flattening
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface FlattenedContent {
  content: string;
  toolCalls: Array<{ id?: string; name: string; input: unknown }>;
  toolResults: Array<{
    toolUseId?: string;
    isError?: boolean;
    content: unknown;
  }>;
}

/**
 * Parse the message `content` JSON string (ContentBlock[]) and extract
 * text, tool_use, and tool_result blocks into flat fields.
 */
export function flattenContentBlocks(
  rawContent: string | ContentBlock[],
): FlattenedContent {
  const result: FlattenedContent = {
    content: "",
    toolCalls: [],
    toolResults: [],
  };

  let blocks: ContentBlock[];
  if (Array.isArray(rawContent)) {
    blocks = rawContent;
  } else {
    try {
      const parsed = JSON.parse(rawContent);
      if (!Array.isArray(parsed)) {
        // Plain text content (not block array)
        return { ...result, content: rawContent };
      }
      blocks = parsed;
    } catch {
      // Not valid JSON — treat as plain text
      return { ...result, content: rawContent };
    }
  }

  const textParts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          textParts.push(block.text);
        }
        break;
      case "tool_use":
        if (typeof block.name === "string") {
          result.toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        break;
      case "tool_result":
        result.toolResults.push({
          toolUseId: block.tool_use_id,
          ...(block.is_error ? { isError: true } : {}),
          content: block.content,
        });
        break;
      // Skip "image" and "file" blocks — represented via attachments
    }
  }

  result.content = textParts.join("\n");
  return result;
}

// ---------------------------------------------------------------------------
// Attachment projection
// ---------------------------------------------------------------------------

/**
 * Resolve a unique filename within a directory, handling collisions by
 * appending a suffix (e.g., `photo-2.png`, `photo-3.png`).
 */
export function resolveUniqueFilename(dir: string, filename: string): string {
  const sanitized = basename(filename);
  if (!existsSync(join(dir, sanitized))) {
    return sanitized;
  }

  const ext = extname(sanitized);
  const base = basename(sanitized, ext);
  let counter = 2;
  let candidate: string;
  do {
    candidate = `${base}-${counter}${ext}`;
    counter++;
  } while (existsSync(join(dir, candidate)));

  return candidate;
}

/**
 * Ensure an attachment is present in the conversation's attachments/
 * subdirectory and return the filename recorded in the disk view.
 */
function writeAttachmentFile(
  conversationDirPath: string,
  attachmentId: string,
  originalFilename: string,
): string | null {
  try {
    const attachDir = join(conversationDirPath, "attachments");
    mkdirSync(attachDir, { recursive: true });

    const existingPath = getFilePathForAttachment(attachmentId);
    if (
      existingPath &&
      existsSync(existingPath) &&
      dirname(existingPath) === attachDir
    ) {
      return basename(existingPath);
    }

    const content = getAttachmentContent(attachmentId);
    if (!content) {
      return null;
    }

    const resolvedName = resolveUniqueFilename(attachDir, originalFilename);
    writeFileSync(join(attachDir, resolvedName), content);
    return resolvedName;
  } catch (err) {
    log.warn(
      { err, attachmentId, originalFilename },
      "Failed to write attachment file to disk",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message sync
// ---------------------------------------------------------------------------

const MESSAGE_LINE_TAIL_BYTES = 1024 * 1024;

/**
 * Append a record to messages.jsonl — or, when the file's last line is a
 * re-sync of the same message (same `messageId`), replace that line in place.
 *
 * The runtime syncs a message more than once: tool-result rows are synced on
 * arrival and re-synced with the full batch at the turn/loop boundary, and the
 * turn's last assistant row is synced at finalize and again at settle. An
 * append-only view stacked duplicate lines for those rows; upsert keeps the
 * file 1-1 with the runtime — one line per DB row, latest content wins.
 */
function appendOrReplaceMessageLine(
  messagesPath: string,
  record: Record<string, unknown>,
): void {
  const line = JSON.stringify(record) + "\n";
  if (!existsSync(messagesPath)) {
    writeFileSync(messagesPath, line);
    return;
  }
  const fd = openSync(messagesPath, "r+");
  try {
    const size = fstatSync(fd).size;
    if (size > 0) {
      const tailLen = Math.min(size, MESSAGE_LINE_TAIL_BYTES);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, size - tailLen);
      const tailText = tail.toString("utf8");
      // Only match the last COMPLETE line; a torn final line falls through
      // to a plain append via the JSON.parse guard below.
      const withoutTrailingNewline = tailText.endsWith("\n")
        ? tailText.slice(0, -1)
        : tailText;
      const lastNewline = withoutTrailingNewline.lastIndexOf("\n");
      const lastLine = withoutTrailingNewline.slice(lastNewline + 1);
      let parsed: { messageId?: unknown } | undefined;
      try {
        parsed = JSON.parse(lastLine) as { messageId?: unknown };
      } catch {
        parsed = undefined;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.messageId != null &&
        parsed.messageId === record.messageId
      ) {
        const lineStart = size - (withoutTrailingNewline.length - lastNewline);
        ftruncateSync(fd, lineStart);
        writeSync(fd, line, lineStart);
        return;
      }
    }
    writeSync(fd, line, size);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a message and its attachments from DB, flatten content, and append
 * a JSONL line to `messages.jsonl` in the conversation's disk-view directory.
 * Attachment filenames are recorded from the conversation's attachments/
 * subdirectory, materializing legacy rows there only when needed.
 *
 * Requires `createdAtMs` of the conversation to resolve the directory path.
 */
export function syncMessageToDisk(
  conversationId: string,
  messageId: string,
  createdAtMs: number,
): void {
  try {
    const message = getMessageById(messageId, conversationId);
    if (!message) {
      log.warn(
        { conversationId, messageId },
        "syncMessageToDisk: message not found",
      );
      return;
    }

    const dirPath = ensureConversationDirPath(conversationId, createdAtMs);
    const { content, toolCalls, toolResults } = flattenContentBlocks(
      message.content,
    );

    // Project attachments to disk
    const attachmentMeta = getAttachmentMetadataForMessage(messageId);
    const attachmentFilenames: string[] = [];
    for (const att of attachmentMeta) {
      const resolved = writeAttachmentFile(
        dirPath,
        att.id,
        att.originalFilename,
      );
      if (resolved) {
        attachmentFilenames.push(resolved);
      }
    }

    // Build JSONL record. `messageId` keys every line to its DB row so a
    // re-synced message upserts (replaces its line) instead of appending a
    // duplicate, and disk records join cleanly against llm_request_logs.
    const record: Record<string, unknown> = {
      messageId: message.id,
      role: message.role,
      ts: new Date(message.createdAt).toISOString(),
    };

    if (content) {
      record.content = content;
    }
    if (toolCalls.length > 0) {
      record.toolCalls = toolCalls;
    }
    if (toolResults.length > 0) {
      record.toolResults = toolResults;
    }
    if (attachmentFilenames.length > 0) {
      record.attachments = attachmentFilenames;
    }
    if (message.metadata) {
      try {
        record.metadata = JSON.parse(message.metadata);
      } catch {
        // Invalid JSON — omit metadata from disk record
      }
    }

    appendOrReplaceMessageLine(join(dirPath, "messages.jsonl"), record);
  } catch (err) {
    log.warn(
      { err, conversationId, messageId },
      "Failed to sync message to disk",
    );
  }
}

/**
 * Rebuild a single conversation's disk view from current DB state.
 *
 * This rewrites append-only `messages.jsonl` and replays all persisted messages
 * in DB order so disk data matches post-mutation state (e.g., after assistant-
 * message consolidation). Existing attachment files are preserved to avoid
 * losing file-backed rows where base64 payloads were already compacted out.
 */
export function rebuildConversationDiskViewFromDbState(
  conversationId: string,
): void {
  try {
    const conv = getConversation(conversationId);
    if (!conv) {
      log.warn(
        { conversationId },
        "rebuildConversationDiskViewFromDbState: conversation not found",
      );
      return;
    }

    const dirPath = ensureConversationDirPath(conversationId, conv.createdAt);
    const messagesPath = join(dirPath, "messages.jsonl");

    rmSync(messagesPath, { force: true });
    writeFileSync(messagesPath, "");
    // Preserve attachment files: many attachment rows are file-backed with
    // data_base64 cleared, so deleting attachments/ can make content
    // unrecoverable for replay.
    mkdirSync(join(dirPath, "attachments"), { recursive: true });

    const convMessages = getMessages(conversationId);
    for (const msg of convMessages) {
      syncMessageToDisk(conversationId, msg.id, conv.createdAt);
    }

    updateMetaFile(conv);
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to rebuild conversation disk view from DB state",
    );
  }
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove a conversation's disk-view directory entirely.
 */
export function removeConversationDir(id: string, createdAtMs: number): void {
  try {
    const dirPaths = new Set([
      getConversationDirPath(id, createdAtMs),
      getLegacyConversationDirPath(id, createdAtMs),
    ]);
    for (const dirPath of dirPaths) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    log.warn({ err, conversationId: id }, "Failed to remove conversation dir");
  }
}
