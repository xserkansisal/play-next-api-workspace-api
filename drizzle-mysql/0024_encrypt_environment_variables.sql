ALTER TABLE `environment_variables` ADD `is_secret` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `environment_variables` ADD `value_encryption_version` int;