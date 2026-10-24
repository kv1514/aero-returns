DROP INDEX `drones_phone`;--> statement-breakpoint
ALTER TABLE `drones` ADD `phone_verified` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `drones_phone` ON `drones` (`phone`);--> statement-breakpoint
ALTER TABLE `drone_commands` ADD `send_count` integer DEFAULT 0 NOT NULL;