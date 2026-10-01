CREATE TABLE `auth_codes` (
	`id` varchar(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`expires_at` varchar(24) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`consumed_at` varchar(24),
	CONSTRAINT `auth_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`email` varchar(320) NOT NULL,
	`purpose` enum('request_code','verify_code') NOT NULL,
	`window_started_at` varchar(24) NOT NULL,
	`attempts` int NOT NULL,
	CONSTRAINT `auth_rate_limits_pk` PRIMARY KEY(`email`,`purpose`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`expires_at` varchar(24) NOT NULL,
	`revoked_at` varchar(24),
	CONSTRAINT `auth_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`name_key` varchar(400) NOT NULL,
	`active_name_key` varchar(400) GENERATED ALWAYS AS (CASE WHEN `deleted_at` IS NULL THEN `name_key` ELSE NULL END) VIRTUAL,
	`description` text NOT NULL DEFAULT (''),
	`created_at` varchar(24) NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	`deleted_at` varchar(24),
	`created_by` varchar(36),
	`updated_by` varchar(36),
	CONSTRAINT `collections_id` PRIMARY KEY(`id`),
	CONSTRAINT `collections_active_name_unique` UNIQUE(`active_name_key`)
);
--> statement-breakpoint
CREATE TABLE `environment_variables` (
	`environment_id` varchar(36) NOT NULL,
	`position` int NOT NULL,
	`key` varchar(200) NOT NULL,
	`value` varchar(8192) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `environment_variables_pk` PRIMARY KEY(`environment_id`,`position`),
	CONSTRAINT `environment_variables_key_unique` UNIQUE(`environment_id`,`key`),
	CONSTRAINT `environment_variables_position_check` CHECK(`environment_variables`.`position` >= 0)
);
--> statement-breakpoint
CREATE TABLE `environments` (
	`id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`name_key` varchar(400) NOT NULL,
	`active_name_key` varchar(400) GENERATED ALWAYS AS (CASE WHEN `deleted_at` IS NULL THEN `name_key` ELSE NULL END) VIRTUAL,
	`created_at` varchar(24) NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	`deleted_at` varchar(24),
	`created_by` varchar(36),
	`updated_by` varchar(36),
	CONSTRAINT `environments_id` PRIMARY KEY(`id`),
	CONSTRAINT `environments_active_name_unique` UNIQUE(`active_name_key`)
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` varchar(36) NOT NULL,
	`collection_id` varchar(36) NOT NULL,
	`parent_id` varchar(36),
	`parent_key` varchar(36) GENERATED ALWAYS AS (coalesce(`parent_id`, '')) VIRTUAL,
	`kind` enum('folder','request') NOT NULL,
	`name` varchar(200) NOT NULL,
	`name_key` varchar(400) NOT NULL,
	`active_folder_name_key` varchar(400) GENERATED ALWAYS AS (CASE WHEN `kind` = 'folder' AND `deleted_at` IS NULL THEN `name_key` ELSE NULL END) VIRTUAL,
	`description` text NOT NULL DEFAULT (''),
	`created_at` varchar(24) NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	`deleted_at` varchar(24),
	`trash_root_id` varchar(36),
	`created_by` varchar(36),
	`updated_by` varchar(36),
	CONSTRAINT `items_id` PRIMARY KEY(`id`),
	CONSTRAINT `items_id_collection_unique` UNIQUE(`id`,`collection_id`),
	CONSTRAINT `items_active_sibling_folder_name_unique` UNIQUE(`collection_id`,`parent_key`,`active_folder_name_key`),
	CONSTRAINT `items_trash_state_check` CHECK((`items`.`deleted_at` IS NULL) = (`items`.`trash_root_id` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `request_details` (
	`item_id` varchar(36) NOT NULL,
	`method` enum('GET','POST','PUT','PATCH','DELETE') NOT NULL,
	`url` varchar(8192) NOT NULL,
	`body_type` enum('json'),
	`body_content` mediumtext,
	`auth_type` enum('none') NOT NULL DEFAULT 'none',
	CONSTRAINT `request_details_item_id` PRIMARY KEY(`item_id`),
	CONSTRAINT `request_details_body_check` CHECK((`request_details`.`body_type` IS NULL AND `request_details`.`body_content` IS NULL) OR (`request_details`.`body_type` = 'json' AND `request_details`.`body_content` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `request_headers` (
	`request_id` varchar(36) NOT NULL,
	`position` int NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text NOT NULL DEFAULT (''),
	`enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `request_headers_pk` PRIMARY KEY(`request_id`,`position`),
	CONSTRAINT `request_headers_position_check` CHECK(`request_headers`.`position` >= 0)
);
--> statement-breakpoint
CREATE TABLE `request_query_params` (
	`request_id` varchar(36) NOT NULL,
	`position` int NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text NOT NULL DEFAULT (''),
	`enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `request_query_params_pk` PRIMARY KEY(`request_id`,`position`),
	CONSTRAINT `request_query_params_position_check` CHECK(`request_query_params`.`position` >= 0)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`created_at` varchar(24) NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `variables` (
	`id` varchar(36) NOT NULL,
	`scope` enum('user','global') NOT NULL,
	`user_id` varchar(36),
	`key` varchar(200) NOT NULL,
	`user_scoped_key` varchar(200) GENERATED ALWAYS AS (CASE WHEN `scope` = 'user' THEN `key` ELSE NULL END) VIRTUAL,
	`global_scoped_key` varchar(200) GENERATED ALWAYS AS (CASE WHEN `scope` = 'global' THEN `key` ELSE NULL END) VIRTUAL,
	`value` mediumtext NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	`updated_by` varchar(36),
	CONSTRAINT `variables_id` PRIMARY KEY(`id`),
	CONSTRAINT `variables_user_key_unique` UNIQUE(`user_id`,`user_scoped_key`),
	CONSTRAINT `variables_global_key_unique` UNIQUE(`global_scoped_key`),
	CONSTRAINT `variables_owner_check` CHECK((`variables`.`scope` = 'user' AND `variables`.`user_id` IS NOT NULL) OR (`variables`.`scope` = 'global' AND `variables`.`user_id` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collections` ADD CONSTRAINT `collections_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collections` ADD CONSTRAINT `collections_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environment_variables` ADD CONSTRAINT `environment_variables_environment_id_environments_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `items` ADD CONSTRAINT `items_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `items` ADD CONSTRAINT `items_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `items` ADD CONSTRAINT `items_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `items` ADD CONSTRAINT `items_parent_same_collection_fk` FOREIGN KEY (`parent_id`,`collection_id`) REFERENCES `items`(`id`,`collection_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_details` ADD CONSTRAINT `request_details_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_headers` ADD CONSTRAINT `request_headers_request_id_request_details_item_id_fk` FOREIGN KEY (`request_id`) REFERENCES `request_details`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_query_params` ADD CONSTRAINT `request_query_params_request_id_request_details_item_id_fk` FOREIGN KEY (`request_id`) REFERENCES `request_details`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `variables` ADD CONSTRAINT `variables_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `variables` ADD CONSTRAINT `variables_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `auth_codes_email_created_idx` ON `auth_codes` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `items_collection_parent_idx` ON `items` (`collection_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `items_trash_root_idx` ON `items` (`trash_root_id`);