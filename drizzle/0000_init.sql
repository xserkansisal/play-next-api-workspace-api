CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_active_name_unique` ON `collections` (`name_key`) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `environment_variables` (
	`environment_id` text NOT NULL,
	`position` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`environment_id`, `position`),
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "environment_variables_position_check" CHECK("position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_variables_key_unique` ON `environment_variables` (`environment_id`,`key`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`parent_id` text,
	`parent_key` text GENERATED ALWAYS AS (coalesce("parent_id", '')) VIRTUAL NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`trash_root_id` text,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`,`collection_id`) REFERENCES `items`(`id`,`collection_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "items_kind_check" CHECK("kind" IN ('folder', 'request')),
	CONSTRAINT "items_trash_state_check" CHECK(("deleted_at" IS NULL) = ("trash_root_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_id_collection_unique` ON `items` (`id`,`collection_id`);--> statement-breakpoint
CREATE INDEX `items_collection_parent_idx` ON `items` (`collection_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `items_trash_root_idx` ON `items` (`trash_root_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_active_sibling_folder_name_unique` ON `items` (`collection_id`,`parent_key`,`name_key`) WHERE "kind" = 'folder' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `request_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`body_type` text,
	`body_content` text,
	`auth_type` text DEFAULT 'none' NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "request_details_method_check" CHECK("method" IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "request_details_auth_check" CHECK("auth_type" = 'none'),
	CONSTRAINT "request_details_body_check" CHECK(("body_type" IS NULL AND "body_content" IS NULL) OR ("body_type" = 'json' AND "body_content" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `request_headers` (
	`request_id` text NOT NULL,
	`position` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`request_id`, `position`),
	FOREIGN KEY (`request_id`) REFERENCES `request_details`(`item_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "request_headers_position_check" CHECK("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE `request_query_params` (
	`request_id` text NOT NULL,
	`position` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`request_id`, `position`),
	FOREIGN KEY (`request_id`) REFERENCES `request_details`(`item_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "request_query_params_position_check" CHECK("position" >= 0)
);
