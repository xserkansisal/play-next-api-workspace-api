CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`user_id` text,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "variables_scope_check" CHECK("scope" IN ('user', 'global')),
	CONSTRAINT "variables_owner_check" CHECK(("scope" = 'user' AND "user_id" IS NOT NULL) OR ("scope" = 'global' AND "user_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_user_key_unique` ON `variables` (`user_id`,`key`) WHERE "scope" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX `variables_global_key_unique` ON `variables` (`key`) WHERE "scope" = 'global';