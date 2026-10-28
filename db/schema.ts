import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
// A versioned aggregate stores the deterministic flight clock and event journal.
export const returns = sqliteTable('returns', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), createdAt: integer('created_at').notNull(),
  version: integer('version').notNull().default(0), record: text('record').notNull(),
}, table => [index('returns_owner_created').on(table.owner, table.createdAt)]);
export const integrationEvents = sqliteTable('integration_events', {
  id:text('id').primaryKey(), owner:text('owner').notNull(), kind:text('kind').notNull(),
  createdAt:integer('created_at').notNull(), status:text('status').notNull(), result:text('result').notNull(),
},table=>[index('integration_owner_created').on(table.owner,table.createdAt),index('integration_kind_created').on(table.kind,table.createdAt)]);
export const amazonAccounts=sqliteTable('amazon_accounts',{
 owner:text('owner').primaryKey(),amazonUserId:text('amazon_user_id').notNull(),name:text('name').notNull(),email:text('email').notNull(),linkedAt:integer('linked_at').notNull(),
});
export const amazonOAuthStates=sqliteTable('amazon_oauth_states',{
 state:text('state').primaryKey(),owner:text('owner').notNull(),verifier:text('verifier').notNull(),expiresAt:integer('expires_at').notNull(),
},table=>[index('amazon_oauth_owner').on(table.owner)]);
// Live drone link (docs/DRONE_LINK.md). Keys are derived from DRONE_LINK_SECRET and never stored.
export const drones=sqliteTable('drones',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),name:text('name').notNull(),transport:text('transport').notNull(),phone:text('phone'),
 keyVersion:integer('key_version').notNull().default(1),config:text('config').notNull(),armedUntil:integer('armed_until').notNull().default(0),
 activeReturn:text('active_return'),lastSeq:integer('last_seq').notNull().default(0),cmdSeq:integer('cmd_seq').notNull().default(0),
 lastSeen:integer('last_seen').notNull().default(0),telemetry:text('telemetry'),createdAt:integer('created_at').notNull(),
 // SMS goes out only after a signed text arrives from this number; numbers are unique so inbound routing is unambiguous.
 phoneVerified:integer('phone_verified').notNull().default(0),
},table=>[index('drones_owner').on(table.owner),uniqueIndex('drones_phone').on(table.phone)]);
export const droneCommands=sqliteTable('drone_commands',{
 id:text('id').primaryKey(),droneId:text('drone_id').notNull(),seq:integer('seq').notNull(),type:text('type').notNull(),line:text('line').notNull(),
 returnId:text('return_id'),phase:text('phase'),status:text('status').notNull(),reason:text('reason'),
 createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),updatedAt:integer('updated_at').notNull(),
 sendCount:integer('send_count').notNull().default(0),
},table=>[uniqueIndex('drone_commands_seq').on(table.droneId,table.seq),index('drone_commands_status').on(table.droneId,table.status)]);
export const droneTelemetry=sqliteTable('drone_telemetry',{
 droneId:text('drone_id').notNull(),seq:integer('seq').notNull(),receivedAt:integer('received_at').notNull(),data:text('data').notNull(),
},table=>[primaryKey({columns:[table.droneId,table.seq]}),index('drone_telemetry_received').on(table.droneId,table.receivedAt)]);
