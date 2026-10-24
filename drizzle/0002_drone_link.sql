CREATE TABLE `drone_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`drone_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`line` text NOT NULL,
	`return_id` text,
	`phase` text,
	`status` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drone_commands_seq` ON `drone_commands` (`drone_id`,`seq`);--> statement-breakpoint
CREATE INDEX `drone_commands_status` ON `drone_commands` (`drone_id`,`status`);--> statement-breakpoint
CREATE TABLE `drone_telemetry` (
	`drone_id` text NOT NULL,
	`seq` integer NOT NULL,
	`received_at` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`drone_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `drone_telemetry_received` ON `drone_telemetry` (`drone_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `drones` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`phone` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`config` text NOT NULL,
	`armed_until` integer DEFAULT 0 NOT NULL,
	`active_return` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`cmd_seq` integer DEFAULT 0 NOT NULL,
	`last_seen` integer DEFAULT 0 NOT NULL,
	`telemetry` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drones_owner` ON `drones` (`owner`);--> statement-breakpoint
CREATE INDEX `drones_phone` ON `drones` (`phone`);