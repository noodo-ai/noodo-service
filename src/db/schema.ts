import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
export const users = sqliteTable('users', {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  passwordHash: text().notNull(),
  createdAt: integer().notNull(),
})
export const sessions = sqliteTable('sessions', {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer().notNull(),
})
export const conversations = sqliteTable('conversations', {
  deletedAt: integer(),
  id: text().primaryKey(),
  ownerId: text()
    .notNull()
    .references(() => users.id),
  observedAddress: text(),
  addressVersion: integer().notNull(),
  title: text().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
})
export const runs = sqliteTable('runs', {
  id: text().primaryKey(),
  conversationId: text()
    .notNull()
    .references(() => conversations.id),
  ownerId: text()
    .notNull()
    .references(() => users.id),
  clientRequestId: text().notNull(),
  requestHash: text().notNull(),
  status: text().notNull(),
  observedAddress: text(),
  addressVersion: integer().notNull(),
  marketScope: text().notNull(),
  result: text(),
  error: text(),
  provider: text().notNull(),
  model: text().notNull(),
  adapterVersion: text().notNull(),
  promptVersion: text().notNull(),
  tokenUsage: text().notNull(),
  quotaDate: text().notNull(),
  reservedTokens: integer().notNull(),
  settledTokens: integer(),
  settledAt: integer(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
})
export const messages = sqliteTable('messages', {
  id: text().primaryKey(),
  conversationId: text()
    .notNull()
    .references(() => conversations.id),
  runId: text()
    .notNull()
    .references(() => runs.id),
  role: text().notNull(),
  text: text().notNull(),
  textStatus: text().notNull(),
  observedAddress: text(),
  addressVersion: integer().notNull(),
  createdAt: integer().notNull(),
})
export const toolCalls = sqliteTable('tool_calls', {
  id: text().primaryKey(),
  runId: text()
    .notNull()
    .references(() => runs.id),
  providerToolUseId: text().notNull(),
  name: text().notNull(),
  arguments: text().notNull(),
  version: text().notNull(),
  status: text().notNull(),
  result: text(),
  error: text(),
  assistantContent: text().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
})
