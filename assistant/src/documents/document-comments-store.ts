/**
 * CRUD operations for document comments.
 *
 * All queries go through drizzle — the model maps the snake_case DB columns to
 * the camelCase `CommentRecord` fields via `mapRowToComment()`.
 */
import { randomUUID } from "node:crypto";

import { and, asc, count, eq, isNull } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { rawChanges } from "../persistence/raw-query.js";
import { documentComments } from "../persistence/schema/documents.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("document-comments-store");

/** A comment record with camelCase fields mapped from the drizzle row. */
export interface CommentRecord {
  id: string;
  surfaceId: string;
  conversationId: string;
  author: string;
  content: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  anchorText: string | null;
  parentCommentId: string | null;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function mapRowToComment(
  row: typeof documentComments.$inferSelect,
): CommentRecord {
  return {
    id: row.id,
    surfaceId: row.surfaceId,
    conversationId: row.conversationId,
    author: row.author,
    content: row.content,
    anchorStart: row.anchorStart,
    anchorEnd: row.anchorEnd,
    anchorText: row.anchorText,
    parentCommentId: row.parentCommentId,
    status: row.status as CommentRecord["status"],
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createComment(params: {
  surfaceId: string;
  conversationId: string;
  author: string;
  content: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  anchorText?: string | null;
  parentCommentId?: string | null;
}): CommentRecord {
  const id = `comment-${randomUUID()}`;
  const now = Date.now();

  getDb()
    .insert(documentComments)
    .values({
      id,
      surfaceId: params.surfaceId,
      conversationId: params.conversationId,
      author: params.author,
      content: params.content,
      anchorStart: params.anchorStart ?? null,
      anchorEnd: params.anchorEnd ?? null,
      anchorText: params.anchorText ?? null,
      parentCommentId: params.parentCommentId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  log.info({ id, surfaceId: params.surfaceId }, "Created comment");

  return {
    id,
    surfaceId: params.surfaceId,
    conversationId: params.conversationId,
    author: params.author,
    content: params.content,
    anchorStart: params.anchorStart ?? null,
    anchorEnd: params.anchorEnd ?? null,
    anchorText: params.anchorText ?? null,
    parentCommentId: params.parentCommentId ?? null,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getComment(id: string): CommentRecord | null {
  const row = getDb()
    .select()
    .from(documentComments)
    .where(eq(documentComments.id, id))
    .get();
  return row ? mapRowToComment(row) : null;
}

export function listComments(
  surfaceId: string,
  opts?: {
    status?: "open" | "resolved" | "all";
    topLevelOnly?: boolean;
  },
): CommentRecord[] {
  const status = opts?.status ?? "all";
  const topLevelOnly = opts?.topLevelOnly ?? false;

  const conditions = [eq(documentComments.surfaceId, surfaceId)];

  if (status !== "all") {
    conditions.push(eq(documentComments.status, status));
  }

  if (topLevelOnly) {
    conditions.push(isNull(documentComments.parentCommentId));
  }

  const rows = getDb()
    .select()
    .from(documentComments)
    .where(and(...conditions))
    .orderBy(asc(documentComments.createdAt))
    .all();

  return rows.map(mapRowToComment);
}

export function resolveComment(id: string, resolvedBy: string): boolean {
  const now = Date.now();
  getDb()
    .update(documentComments)
    .set({
      status: "resolved",
      resolvedBy,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(documentComments.id, id))
    .run();
  const changes = rawChanges();
  if (changes > 0) {
    log.info({ id, resolvedBy }, "Resolved comment");
  }
  return changes > 0;
}

export function reopenComment(id: string): boolean {
  const now = Date.now();
  getDb()
    .update(documentComments)
    .set({
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      updatedAt: now,
    })
    .where(eq(documentComments.id, id))
    .run();
  const changes = rawChanges();
  if (changes > 0) {
    log.info({ id }, "Reopened comment");
  }
  return changes > 0;
}

export function updateCommentContent(id: string, content: string): boolean {
  const now = Date.now();
  getDb()
    .update(documentComments)
    .set({ content, updatedAt: now })
    .where(eq(documentComments.id, id))
    .run();
  const changes = rawChanges();
  if (changes > 0) {
    log.info({ id }, "Updated comment content");
  }
  return changes > 0;
}

export function deleteComment(id: string): boolean {
  // Replies cascade-delete via the self-referential FK on parent_comment_id.
  getDb().delete(documentComments).where(eq(documentComments.id, id)).run();
  const changes = rawChanges();
  if (changes > 0) {
    log.info({ id }, "Deleted comment and its replies");
  }
  return changes > 0;
}

export function getCommentCountForDocument(surfaceId: string): number {
  const rows = getDb()
    .select({ count: count() })
    .from(documentComments)
    .where(
      and(
        eq(documentComments.surfaceId, surfaceId),
        eq(documentComments.status, "open"),
      ),
    )
    .get();
  return rows?.count ?? 0;
}
