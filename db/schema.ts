import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
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
// Real drones linked by their owners. The agent authenticates with a token; only sha256(secret) is stored.
export const drones=sqliteTable('drones',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),name:text('name').notNull(),tokenHash:text('token_hash').notNull(),
 pilots:text('pilots').notNull().default('[]'),pilotCode:text('pilot_code'),phone:text('phone'),
 homeLng:real('home_lng'),homeLat:real('home_lat'),geofenceM:integer('geofence_m').notNull().default(500),maxAltM:integer('max_alt_m').notNull().default(40),
 createdAt:integer('created_at').notNull(),lastSeen:integer('last_seen'),telemetry:text('telemetry'),trail:text('trail').notNull().default('[]'),
},table=>[index('drones_owner').on(table.owner),index('drones_pilot_code').on(table.pilotCode)]);
export const droneCommands=sqliteTable('drone_commands',{
 id:text('id').primaryKey(),droneId:text('drone_id').notNull(),issuedBy:text('issued_by').notNull(),type:text('type').notNull(),params:text('params'),
 status:text('status').notNull(),channel:text('channel').notNull(),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
 expiresAt:integer('expires_at').notNull(),message:text('message'),
},table=>[index('drone_commands_drone_created').on(table.droneId,table.createdAt)]);
