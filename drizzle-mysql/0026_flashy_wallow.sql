CREATE TABLE `request_script_links` (
	`request_id` varchar(36) NOT NULL,
	`script_id` varchar(36) NOT NULL,
	`stage` enum('pre-request','post-response') NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `request_script_links_pk` PRIMARY KEY(`request_id`,`stage`,`position`),
	CONSTRAINT `request_script_links_script_unique` UNIQUE(`request_id`,`script_id`,`stage`)
);
--> statement-breakpoint
CREATE TABLE `team_scripts` (
	`id` varchar(36) NOT NULL,
	`team_id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`name_key` varchar(400) NOT NULL,
	`description` text NOT NULL DEFAULT (''),
	`stage` enum('pre-request','post-response') NOT NULL,
	`source` mediumtext NOT NULL,
	`created_at` varchar(24) NOT NULL,
	`updated_at` varchar(24) NOT NULL,
	`created_by` varchar(36),
	`updated_by` varchar(36),
	CONSTRAINT `team_scripts_id` PRIMARY KEY(`id`),
	CONSTRAINT `team_scripts_team_stage_name_unique` UNIQUE(`team_id`,`stage`,`name_key`)
);
--> statement-breakpoint
ALTER TABLE `request_script_links` ADD CONSTRAINT `request_script_links_request_id_items_id_fk` FOREIGN KEY (`request_id`) REFERENCES `items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_script_links` ADD CONSTRAINT `request_script_links_script_id_team_scripts_id_fk` FOREIGN KEY (`script_id`) REFERENCES `team_scripts`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_scripts` ADD CONSTRAINT `team_scripts_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_scripts` ADD CONSTRAINT `team_scripts_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_scripts` ADD CONSTRAINT `team_scripts_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `request_script_links_script_idx` ON `request_script_links` (`script_id`);--> statement-breakpoint
CREATE INDEX `team_scripts_team_updated_idx` ON `team_scripts` (`team_id`,`updated_at`);