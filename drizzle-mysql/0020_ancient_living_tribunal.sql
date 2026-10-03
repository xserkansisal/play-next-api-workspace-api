CREATE TABLE `openapi_sync_items` (
	`item_id` varchar(36) NOT NULL,
	`collection_id` varchar(36) NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`operation_id` varchar(500),
	`method` enum('GET','POST','PUT','PATCH','DELETE') NOT NULL,
	`path` varchar(8192) NOT NULL,
	`source_snapshot` json NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	CONSTRAINT `openapi_sync_items_item_id` PRIMARY KEY(`item_id`),
	CONSTRAINT `openapi_sync_items_identity_unique` UNIQUE(`collection_id`,`identity_hash`)
);
--> statement-breakpoint
CREATE TABLE `openapi_syncs` (
	`collection_id` varchar(36) NOT NULL,
	`spec_hash` varchar(64) NOT NULL,
	`spec_title` varchar(200) NOT NULL,
	`spec_version` varchar(100) NOT NULL,
	`synced_at` varchar(24) NOT NULL,
	`updated_by` varchar(36),
	CONSTRAINT `openapi_syncs_collection_id` PRIMARY KEY(`collection_id`)
);
--> statement-breakpoint
ALTER TABLE `openapi_sync_items` ADD CONSTRAINT `openapi_sync_items_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `openapi_sync_items` ADD CONSTRAINT `openapi_sync_items_collection_id_openapi_syncs_collection_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `openapi_syncs`(`collection_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `openapi_syncs` ADD CONSTRAINT `openapi_syncs_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `openapi_syncs` ADD CONSTRAINT `openapi_syncs_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `openapi_sync_items_collection_idx` ON `openapi_sync_items` (`collection_id`);