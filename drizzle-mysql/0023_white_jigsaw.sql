CREATE TABLE `collection_tree_versions` (
	`id` varchar(36) NOT NULL,
	`collection_id` varchar(36) NOT NULL,
	`snapshot` json NOT NULL,
	`item_count` int NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`created_by` varchar(36),
	CONSTRAINT `collection_tree_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `collection_tree_versions` ADD CONSTRAINT `collection_tree_versions_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collection_tree_versions` ADD CONSTRAINT `collection_tree_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `collection_tree_versions_collection_created_idx` ON `collection_tree_versions` (`collection_id`,`created_at`);