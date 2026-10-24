CREATE TABLE `integration_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integration_owner_created` ON `integration_events` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `returns_owner_created` ON `returns` (`owner`,`created_at`);