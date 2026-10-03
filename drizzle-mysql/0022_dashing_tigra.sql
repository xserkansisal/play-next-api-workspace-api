CREATE TABLE `team_activity_log` (
	`id` varchar(36) NOT NULL,
	`team_id` varchar(36) NOT NULL,
	`actor_id` varchar(36),
	`actor_email` varchar(320) NOT NULL,
	`action` varchar(64) NOT NULL,
	`resource_type` enum('collection','folder','request','environment','variable') NOT NULL,
	`resource_id` varchar(36) NOT NULL,
	`resource_name` varchar(256) NOT NULL,
	`collection_id` varchar(36),
	`details` json NOT NULL,
	`created_at` varchar(24) NOT NULL,
	CONSTRAINT `team_activity_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `team_activity_log_team_created_idx` ON `team_activity_log` (`team_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `team_activity_log_team_resource_idx` ON `team_activity_log` (`team_id`,`resource_type`,`resource_id`,`created_at`);