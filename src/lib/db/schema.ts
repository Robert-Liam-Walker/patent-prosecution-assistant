import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  vector,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const docTypeEnum = pgEnum("doc_type", [
  "user_upload",
  "mpep",
  "patent",
  "patent_application",
  "ptab_decision",
  "fed_circuit",
  "usc",
  "cfr",
  "office_action",
]);

// What kind of document a user uploaded. Drafting needs to distinguish an
// invention disclosure from an office action; before this existed everything
// was indistinguishable, so pre-existing rows default to 'other'.
export const docKindEnum = pgEnum("doc_kind", [
  "disclosure",
  "office_action",
  "claims",
  "prior_art",
  "specification",
  "other",
]);

export const draftKindEnum = pgEnum("draft_kind", ["application", "amendment"]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
  "tool",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    applicationNumber: text("application_number"),
    dateStarted: timestamp("date_started"),
    nextActionDate: timestamp("next_action_date"),
    statusCached: jsonb("status_cached"),
    statusCachedAt: timestamp("status_cached_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("cases_user_idx").on(t.userId)],
);

export const caseDocs = pgTable(
  "case_docs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    storageKey: text("storage_key").notNull(), // R2 key or local path
    sizeBytes: integer("size_bytes"),
    chunkCount: integer("chunk_count").default(0).notNull(),
    kind: docKindEnum("kind").default("other").notNull(),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  },
  (t) => [index("case_docs_case_idx").on(t.caseId)],
);

// Unified chunk table — global corpus rows have case_id = NULL.
// 1024 dims to match Together AI's BGE-large-en-v1.5.
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id").references(() => cases.id, {
      onDelete: "cascade",
    }), // null = global
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }), // null = global
    docId: uuid("doc_id").references(() => caseDocs.id, {
      onDelete: "cascade",
    }), // null = global
    docType: docTypeEnum("doc_type").notNull(),
    source: text("source").notNull(), // e.g., "MPEP 2106"
    sourceUrl: text("source_url"),
    citation: text("citation").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("chunks_case_idx").on(t.caseId),
    index("chunks_doctype_idx").on(t.docType),
    index("chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }), // null = global chat
    title: text("title").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("conversations_user_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"), // [{ chunkId, source, sourceUrl }]
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId)],
);

export const usptoCache = pgTable("uspto_cache", {
  key: text("key").primaryKey(), // e.g., "status:17/123,456"
  payload: jsonb("payload").notNull(),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
});

// Records which embedding model wrote the vectors currently in `chunks`.
//
// Cosine similarity is only meaningful within a single embedding space. If the
// query is embedded by one model while the stored vectors came from another,
// retrieval does not error -- it silently returns near-random neighbours that
// look plausible. That is the worst possible failure mode for a grounded legal
// tool, so the provenance is written down and checked rather than assumed.
// Generated drafts. `sections` is jsonb keyed by section name (title,
// background, claims, ...) rather than one text blob, so a single section can
// be regenerated without rewriting the rest of the document.
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: draftKindEnum("kind").notNull(),
    title: text("title").notNull(),
    sections: jsonb("sections").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("drafts_case_idx").on(t.caseId)],
);

export const embeddingMeta = pgTable("embedding_meta", {
  id: text("id").primaryKey(), // always "current"
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  cases: many(cases),
  conversations: many(conversations),
}));
export const casesRelations = relations(cases, ({ one, many }) => ({
  user: one(users, { fields: [cases.userId], references: [users.id] }),
  docs: many(caseDocs),
  conversations: many(conversations),
}));
export const caseDocsRelations = relations(caseDocs, ({ one, many }) => ({
  case: one(cases, { fields: [caseDocs.caseId], references: [cases.id] }),
  chunks: many(chunks),
}));
export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [conversations.userId],
      references: [users.id],
    }),
    case: one(cases, {
      fields: [conversations.caseId],
      references: [cases.id],
    }),
    messages: many(messages),
  }),
);
export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
