CREATE TABLE `user_preferences` (
	`user_id` varchar(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`value` json NOT NULL,
	CONSTRAINT `user_preferences_pk` PRIMARY KEY(`user_id`,`name`)
);
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD CONSTRAINT `user_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;