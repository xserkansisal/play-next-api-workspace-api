CREATE TABLE `auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `auth_codes_email_created_idx` ON `auth_codes` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`email` text NOT NULL,
	`purpose` text NOT NULL,
	`window_started_at` text NOT NULL,
	`attempts` integer NOT NULL,
	PRIMARY KEY(`email`, `purpose`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `collections` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `collections` ADD `updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `environments` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `environments` ADD `updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `items` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `items` ADD `updated_by` text REFERENCES users(id);