CREATE TABLE `test_run_results` (
	`id` varchar(36) NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`position` int NOT NULL,
	`item_id` varchar(36) NOT NULL,
	`item_name` varchar(200) NOT NULL,
	`status` enum('passed','failed','error','skipped') NOT NULL,
	`http_status` int,
	`duration_ms` int NOT NULL,
	`response_size_bytes` int,
	`response_preview` text,
	`response_truncated` boolean NOT NULL DEFAULT false,
	`assertions` json NOT NULL,
	`error_code` varchar(64),
	CONSTRAINT `test_run_results_id` PRIMARY KEY(`id`),
	CONSTRAINT `test_run_results_position_check` CHECK(`test_run_results`.`position` >= 0)
);
--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` varchar(36) NOT NULL,
	`collection_id` varchar(36) NOT NULL,
	`folder_id` varchar(36),
	`environment_id` varchar(36),
	`user_id` varchar(36) NOT NULL,
	`status` enum('running','passed','failed','error') NOT NULL,
	`request_count` int NOT NULL,
	`passed_count` int NOT NULL DEFAULT 0,
	`failed_count` int NOT NULL DEFAULT 0,
	`started_at` varchar(24) NOT NULL,
	`finished_at` varchar(24),
	`duration_ms` int,
	CONSTRAINT `test_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `request_details` ADD `pre_request_script` mediumtext DEFAULT ('') NOT NULL;--> statement-breakpoint
ALTER TABLE `request_details` ADD `post_response_script` mediumtext DEFAULT ('') NOT NULL;--> statement-breakpoint
ALTER TABLE `test_run_results` ADD CONSTRAINT `test_run_results_run_id_test_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `test_runs` ADD CONSTRAINT `test_runs_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `test_runs` ADD CONSTRAINT `test_runs_environment_id_environments_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `test_runs` ADD CONSTRAINT `test_runs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `test_run_results_run_position_idx` ON `test_run_results` (`run_id`,`position`);--> statement-breakpoint
CREATE INDEX `test_runs_collection_user_started_idx` ON `test_runs` (`collection_id`,`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `test_runs_user_started_idx` ON `test_runs` (`user_id`,`started_at`);