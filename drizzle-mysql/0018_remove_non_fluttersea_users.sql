-- Accounts are now canonical under @fluttersea.com: sign-in rewrites sisal.com / sisal.it addresses
-- to it. Accounts that were created under any other domain would never be reached again, so they
-- are removed together with what only they owned. Shared content they authored stays; only the
-- authorship reference is cleared. Teams may be left without an owner; a system admin can assign
-- one from the admin panel.
UPDATE `teams` SET `created_by` = NULL WHERE `created_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `teams` SET `updated_by` = NULL WHERE `updated_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `team_members` SET `added_by` = NULL WHERE `added_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `collections` SET `created_by` = NULL WHERE `created_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `collections` SET `updated_by` = NULL WHERE `updated_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `collection_versions` SET `created_by` = NULL WHERE `created_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `items` SET `created_by` = NULL WHERE `created_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `items` SET `updated_by` = NULL WHERE `updated_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `item_versions` SET `created_by` = NULL WHERE `created_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `environments` SET `created_by` = NULL WHERE `created_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `environments` SET `updated_by` = NULL WHERE `updated_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `variables` SET `updated_by` = NULL WHERE `updated_by` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `test_runs` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `variables` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `variable_display_orders` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `auth_sessions` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `team_members` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `user_avatars` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `user_preferences` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `presence_test_users` WHERE `user_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
UPDATE `admin_audit_log` SET `actor_id` = NULL WHERE `actor_id` IN (SELECT `id` FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com');--> statement-breakpoint
DELETE FROM `auth_codes` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com';--> statement-breakpoint
DELETE FROM `auth_rate_limits` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com';--> statement-breakpoint
DELETE FROM `users` WHERE LOWER(`email`) NOT LIKE '%@fluttersea.com';
