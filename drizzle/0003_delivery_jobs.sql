CREATE TABLE `drone_events` (
	`id` text PRIMARY KEY NOT NULL,
	`drone_id` text NOT NULL,
	`job_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drone_events_drone_at` ON `drone_events` (`drone_id`,`at`);--> statement-breakpoint
CREATE TABLE `drone_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`drone_id` text NOT NULL,
	`issued_by` text NOT NULL,
	`return_id` text,
	`status` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drone_jobs_drone_created` ON `drone_jobs` (`drone_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `drone_commands` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `drone_commands` ADD `leg` text;