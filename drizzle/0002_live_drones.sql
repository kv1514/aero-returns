CREATE TABLE `drone_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`drone_id` text NOT NULL,
	`issued_by` text NOT NULL,
	`type` text NOT NULL,
	`params` text,
	`status` text NOT NULL,
	`channel` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `drone_commands_drone_created` ON `drone_commands` (`drone_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `drones` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`pilots` text DEFAULT '[]' NOT NULL,
	`pilot_code` text,
	`phone` text,
	`home_lng` real,
	`home_lat` real,
	`geofence_m` integer DEFAULT 500 NOT NULL,
	`max_alt_m` integer DEFAULT 40 NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer,
	`telemetry` text,
	`trail` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drones_owner` ON `drones` (`owner`);--> statement-breakpoint
CREATE INDEX `drones_pilot_code` ON `drones` (`pilot_code`);