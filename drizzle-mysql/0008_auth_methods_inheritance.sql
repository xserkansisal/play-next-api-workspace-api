ALTER TABLE `request_details` MODIFY COLUMN `auth_type` enum('inherit','none','basic','bearer','api-key') NOT NULL DEFAULT 'inherit';--> statement-breakpoint
ALTER TABLE `collections` ADD `auth_config` json DEFAULT ('null');--> statement-breakpoint
ALTER TABLE `items` ADD `auth_config` json DEFAULT ('null');--> statement-breakpoint
ALTER TABLE `request_details` ADD `auth_config` json;
--> statement-breakpoint
UPDATE `request_details` SET `auth_type` = 'inherit' WHERE `auth_type` = 'none';