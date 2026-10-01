CREATE TABLE `presence_test_users` (
	`user_id` varchar(36) NOT NULL,
	`client_id` varchar(36) NOT NULL,
	`location_kind` enum('collection','folder','request') NOT NULL,
	`collection_id` varchar(36) NOT NULL,
	`item_id` varchar(36),
	`location_updated_at` varchar(24) NOT NULL,
	CONSTRAINT `presence_test_users_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `presence_test_users_client_id_unique` UNIQUE(`client_id`),
	CONSTRAINT `presence_test_location_shape_check` CHECK((`presence_test_users`.`location_kind` = 'collection' AND `presence_test_users`.`item_id` IS NULL) OR (`presence_test_users`.`location_kind` IN ('folder', 'request') AND `presence_test_users`.`item_id` IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE `presence_test_users` ADD CONSTRAINT `presence_test_users_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `presence_test_users` ADD CONSTRAINT `presence_test_users_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `presence_test_users` ADD CONSTRAINT `presence_test_users_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE no action ON UPDATE no action;