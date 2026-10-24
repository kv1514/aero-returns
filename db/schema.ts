import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
// A versioned aggregate stores the deterministic flight clock and event journal.
export const returns = sqliteTable('returns', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), createdAt: integer('created_at').notNull(),
  version: integer('version').notNull().default(0), record: text('record').notNull(),
}, table => [index('returns_owner_created').on(table.owner, table.createdAt)]);
export const integrationEvents = sqliteTable('integration_events', {
  id:text('id').primaryKey(), owner:text('owner').notNull(), kind:text('kind').notNull(),
  createdAt:integer('created_at').notNull(), status:text('status').notNull(), result:text('result').notNull(),
},table=>[index('integration_owner_created').on(table.owner,table.createdAt)]);
