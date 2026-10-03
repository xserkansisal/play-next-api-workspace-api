-- The per-team "admin" role is retired in favour of owner / member / viewer. Existing admins keep
-- the ability to manage members, so they become owners. The enum is widened first so the rows can
-- be converted before the old value is dropped.
ALTER TABLE `team_members` MODIFY COLUMN `role` enum('owner','admin','member','viewer') NOT NULL DEFAULT 'member';--> statement-breakpoint
UPDATE `team_members` SET `role` = 'owner' WHERE `role` = 'admin';--> statement-breakpoint
ALTER TABLE `team_members` MODIFY COLUMN `role` enum('owner','member','viewer') NOT NULL DEFAULT 'member';
