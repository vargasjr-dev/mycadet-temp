import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Per-conversation record of every memory-v3 section ever injected, keyed by
// (page slug, section key: `""` for the page lead or capability content), with
// a pruned_at tombstone so re-injection can be suppressed after pruning and a
// last_selected_at stamp the prune valve ranks eviction by. Lives
// in the dedicated memory database (`assistant-memory.db`), not main, access
// it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`). The
// legacy card-grain `memory_v3_ever_injected` table stays on disk (migrations
// are append-only); the memory plugin copies its rows into this table once
// and deletes a conversation's rows from it on the compaction reset and the
// conversation purge (`v3/plugin-schema.ts`), and nothing else touches it.
export const memoryV3InjectedSections = sqliteTable(
  "memory_v3_injected_sections",
  {
    conversationId: text("conversation_id").notNull(),
    slug: text("slug").notNull(),
    sectionKey: text("section_key").notNull(),
    injectedAt: integer("injected_at").notNull(),
    bytes: integer("bytes").notNull().default(0),
    prunedAt: integer("pruned_at"),
    /** Epoch ms of the latest turn that selected the section, net-new or
     *  already resident: the prune valve's recency, with `injected_at`
     *  standing in while null. Plugin-owned like the table: the memory
     *  plugin's schema ensure (`v3/plugin-schema.ts`) adds it to a table
     *  created before the column existed, so it is null on rows written
     *  before then and on a truncated fork's seeded rows. */
    lastSelectedAt: integer("last_selected_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.conversationId, table.slug, table.sectionKey],
    }),
    index("idx_memory_v3_injected_sections_conv").on(table.conversationId),
  ],
);

// Per-turn log of which memory-v3 pages were selected, with lane attribution.
// Lives in the dedicated memory database (`assistant-memory.db`), not main —
// access it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryV3Selections = sqliteTable(
  "memory_v3_selections",
  {
    conversationId: text("conversation_id").notNull(),
    turn: integer("turn").notNull(),
    slug: text("slug").notNull(),
    source: text("source").notNull(),
    pinned: integer("pinned").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    messageId: text("message_id"),
    sectionOrdinal: integer("section_ordinal"),
    sectionTitle: text("section_title"),
    /** The matched section's `sectionKey` (`v3/types.ts`), the identity the
     *  inspector resolves the section by. Plugin-owned: added by the memory
     *  plugin's schema ensure (`v3/plugin-schema.ts`), not by the migration
     *  chain. `null` for rows written before the column existed and for
     *  selections with no matched section. */
    sectionKey: text("section_key"),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.turn, table.slug] }),
    index("idx_memory_v3_selections_conv").on(table.conversationId, table.turn),
  ],
);

// The memory connection's per-conversation activation-rail marker (migration
// 339 moved it here from main), carrying the memory plugin's per-conversation
// memory-injection opt-out: `memory_injection_off` is 1 when the plugin must
// inject no memory for the conversation — no fresh retrieval of any engine,
// no static essentials/threads block, no PKB context — and absent or 0 for
// the default-on. Plugin-owned like the rest of this file: the memory
// plugin's schema ensure (`memory-injection-store.ts`) adds the column to a
// table created before it existed, not the migration chain. No FK to
// conversations.id (SQLite foreign keys cannot span database files); the
// conversation-delete purge and the clear-all reset sweep it explicitly
// (`conversation-memory-purge.ts`). Fork copies never touch this table, so a
// fork starts with injection on.
export const activationSessions = sqliteTable("activation_sessions", {
  conversationId: text("conversation_id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  memoryInjectionOff: integer("memory_injection_off"),
});
