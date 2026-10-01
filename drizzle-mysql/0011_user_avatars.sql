CREATE TABLE `user_avatars` (
	`user_id` varchar(36) NOT NULL,
	`id` varchar(36) NOT NULL,
	`content_type` varchar(32) NOT NULL,
	`data` mediumblob NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	CONSTRAINT `user_avatars_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `user_avatars_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
ALTER TABLE `user_avatars` ADD CONSTRAINT `user_avatars_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;