CREATE TABLE `collection_versions` (
	`id` varchar(36) NOT NULL,
	`collection_id` varchar(36) NOT NULL,
	`snapshot` json NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`created_by` varchar(36),
	CONSTRAINT `collection_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `item_versions` (
	`id` varchar(36) NOT NULL,
	`item_id` varchar(36) NOT NULL,
	`snapshot` json NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`created_by` varchar(36),
	CONSTRAINT `item_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `collection_versions` ADD CONSTRAINT `collection_versions_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collection_versions` ADD CONSTRAINT `collection_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_versions` ADD CONSTRAINT `item_versions_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_versions` ADD CONSTRAINT `item_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `collection_versions_collection_created_idx` ON `collection_versions` (`collection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `item_versions_item_created_idx` ON `item_versions` (`item_id`,`created_at`);