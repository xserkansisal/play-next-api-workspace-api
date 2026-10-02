-- Everything that existed before teams moves into one "Default" team. It is created without
-- members on purpose: who belongs to it is decided by a later data migration.
INSERT INTO `teams` (`id`, `name`, `name_key`, `description`, `created_at`, `updated_at`)
VALUES ('00000000-0000-4000-8000-000000000001', 'Default', 'default', 'Resources created before teams existed', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'));--> statement-breakpoint
ALTER TABLE `collections` DROP INDEX `collections_active_name_unique`;--> statement-breakpoint
ALTER TABLE `environments` DROP INDEX `environments_active_name_unique`;--> statement-breakpoint
ALTER TABLE `variables` DROP INDEX `variables_global_key_unique`;--> statement-breakpoint
ALTER TABLE `variables` DROP CONSTRAINT `variables_owner_check`;--> statement-breakpoint
ALTER TABLE `collections` ADD `team_id` varchar(36);--> statement-breakpoint
ALTER TABLE `environments` ADD `team_id` varchar(36);--> statement-breakpoint
ALTER TABLE `variables` ADD `team_id` varchar(36);--> statement-breakpoint
UPDATE `collections` SET `team_id` = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
UPDATE `environments` SET `team_id` = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
UPDATE `variables` SET `team_id` = '00000000-0000-4000-8000-000000000001' WHERE `scope` = 'global';--> statement-breakpoint
ALTER TABLE `collections` MODIFY `team_id` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `environments` MODIFY `team_id` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD CONSTRAINT `collections_team_active_name_unique` UNIQUE(`team_id`,`active_name_key`);--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_team_active_name_unique` UNIQUE(`team_id`,`active_name_key`);--> statement-breakpoint
ALTER TABLE `variables` ADD CONSTRAINT `variables_team_global_key_unique` UNIQUE(`team_id`,`global_scoped_key`);--> statement-breakpoint
ALTER TABLE `variables` ADD CONSTRAINT `variables_owner_check` CHECK ((`variables`.`scope` = 'user' AND `variables`.`user_id` IS NOT NULL AND `variables`.`team_id` IS NULL) OR (`variables`.`scope` = 'global' AND `variables`.`user_id` IS NULL AND `variables`.`team_id` IS NOT NULL));--> statement-breakpoint
ALTER TABLE `collections` ADD CONSTRAINT `collections_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `variables` ADD CONSTRAINT `variables_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE no action ON UPDATE no action;
