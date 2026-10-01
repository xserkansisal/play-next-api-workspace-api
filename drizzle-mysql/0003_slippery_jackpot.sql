ALTER TABLE `environment_variables` DROP INDEX `environment_variables_key_unique`;--> statement-breakpoint
ALTER TABLE `environment_variables` MODIFY COLUMN `key` varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE `environment_variables` MODIFY COLUMN `value` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `variables` MODIFY COLUMN `key` varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE `variables` MODIFY COLUMN `user_scoped_key` varchar(256) GENERATED ALWAYS AS (CASE WHEN `scope` = 'user' THEN `key` ELSE NULL END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `variables` MODIFY COLUMN `global_scoped_key` varchar(256) GENERATED ALWAYS AS (CASE WHEN `scope` = 'global' THEN `key` ELSE NULL END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `environment_variables` ADD `enabled_key` varchar(256) GENERATED ALWAYS AS (CASE WHEN `enabled` = 1 THEN `key` ELSE NULL END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `environment_variables` ADD CONSTRAINT `environment_variables_enabled_key_unique` UNIQUE(`environment_id`,`enabled_key`);