/**
 * Document revision history: snapshots of a document's title and body as they
 * stood at a revision, taken just before a write replaces that state.
 *
 * Snapshot writes run inside the caller's transaction, next to the document
 * write they precede, so a snapshot exists exactly when its write landed.
 */
import { and, desc, eq, notInArray } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { documentRevisions } from "../persistence/schema/documents.js";

/** Who made the write a snapshot was taken ahead of. */
export type DocumentRevisionAuthor = "user" | "assistant";

/** Snapshots kept per document; older ones are pruned on each insert. */
export const MAX_REVISIONS_PER_DOCUMENT = 100;

/**
 * A user save snapshots the prior state at most this often per document,
 * unless the latest snapshot preceded an assistant edit.
 */
export const USER_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export interface DocumentRevisionSummary {
  revision: number;
  author: DocumentRevisionAuthor;
  createdAt: number;
  wordCount: number;
  title: string;
}

export interface DocumentRevisionRecord extends DocumentRevisionSummary {
  content: string;
}

/** The document state a snapshot preserves. */
export interface DocumentSnapshotSource {
  surfaceId: string;
  revision: number;
  title: string;
  content: string;
  wordCount: number;
}

interface RevisionRow {
  revision: number;
  author: DocumentRevisionAuthor;
  createdAt: number;
  wordCount: number;
  title: string;
  content: string;
}

function mapRowToSummary(
  row: Omit<RevisionRow, "content">,
): DocumentRevisionSummary {
  return {
    revision: row.revision,
    author: row.author,
    createdAt: row.createdAt,
    wordCount: row.wordCount,
    title: row.title,
  };
}

/**
 * Store `state` as the snapshot for its revision and prune the document's
 * history to the newest {@link MAX_REVISIONS_PER_DOCUMENT}. A revision that is
 * already snapshotted keeps its first snapshot.
 */
export function recordDocumentSnapshot(
  state: DocumentSnapshotSource,
  author: DocumentRevisionAuthor,
): void {
  getDb()
    .insert(documentRevisions)
    .values({
      surfaceId: state.surfaceId,
      revision: state.revision,
      title: state.title,
      content: state.content,
      wordCount: state.wordCount,
      author,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  getDb()
    .delete(documentRevisions)
    .where(
      and(
        eq(documentRevisions.surfaceId, state.surfaceId),
        notInArray(
          documentRevisions.revision,
          getDb()
            .select({ revision: documentRevisions.revision })
            .from(documentRevisions)
            .where(eq(documentRevisions.surfaceId, state.surfaceId))
            .orderBy(desc(documentRevisions.revision))
            .limit(MAX_REVISIONS_PER_DOCUMENT),
        ),
      ),
    )
    .run();
}

/**
 * Whether a user save should snapshot the state it replaces: when the document
 * has no snapshot yet, when the latest one is older than
 * {@link USER_SNAPSHOT_INTERVAL_MS}, or when the latest one preceded an
 * assistant edit, so the assistant's result survives the user's next edits.
 */
export function shouldSnapshotBeforeUserSave(surfaceId: string): boolean {
  const latest = getDb()
    .select({
      author: documentRevisions.author,
      createdAt: documentRevisions.createdAt,
    })
    .from(documentRevisions)
    .where(eq(documentRevisions.surfaceId, surfaceId))
    .orderBy(desc(documentRevisions.revision))
    .limit(1)
    .get();
  if (!latest) {
    return true;
  }
  return (
    latest.author === "assistant" ||
    Date.now() - latest.createdAt >= USER_SNAPSHOT_INTERVAL_MS
  );
}

/** A document's snapshots, newest first, without their bodies. */
export function listDocumentRevisions(
  surfaceId: string,
): DocumentRevisionSummary[] {
  return getDb()
    .select({
      revision: documentRevisions.revision,
      author: documentRevisions.author,
      createdAt: documentRevisions.createdAt,
      wordCount: documentRevisions.wordCount,
      title: documentRevisions.title,
    })
    .from(documentRevisions)
    .where(eq(documentRevisions.surfaceId, surfaceId))
    .orderBy(desc(documentRevisions.revision))
    .all()
    .map((row) =>
      mapRowToSummary({ ...row, author: row.author as DocumentRevisionAuthor }),
    );
}

/** One snapshot with its body, or `null` when it does not exist. */
export function getDocumentRevision(
  surfaceId: string,
  revision: number,
): DocumentRevisionRecord | null {
  const row = getDb()
    .select()
    .from(documentRevisions)
    .where(
      and(
        eq(documentRevisions.surfaceId, surfaceId),
        eq(documentRevisions.revision, revision),
      ),
    )
    .get();
  if (!row) {
    return null;
  }
  return {
    ...mapRowToSummary({
      ...row,
      author: row.author as DocumentRevisionAuthor,
    }),
    content: row.content,
  };
}
