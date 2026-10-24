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
export const amazonAccounts=sqliteTable('amazon_accounts',{
 owner:text('owner').primaryKey(),amazonUserId:text('amazon_user_id').notNull(),name:text('name').notNull(),email:text('email').notNull(),linkedAt:integer('linked_at').notNull(),
});
export const amazonOAuthStates=sqliteTable('amazon_oauth_states',{
 state:text('state').primaryKey(),owner:text('owner').notNull(),verifier:text('verifier').notNull(),expiresAt:integer('expires_at').notNull(),
},table=>[index('amazon_oauth_owner').on(table.owner)]);
