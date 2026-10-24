CREATE TABLE `amazon_accounts` (
	`owner` text PRIMARY KEY NOT NULL,
	`amazon_user_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`linked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `amazon_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`verifier` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `amazon_oauth_owner` ON `amazon_oauth_states` (`owner`);