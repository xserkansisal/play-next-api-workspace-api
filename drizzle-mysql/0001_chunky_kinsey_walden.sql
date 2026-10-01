CREATE TABLE `variable_display_orders` (
	`user_id` varchar(36) NOT NULL,
	`order` json NOT NULL,
	CONSTRAINT `variable_display_orders_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `variable_display_orders` ADD CONSTRAINT `variable_display_orders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;