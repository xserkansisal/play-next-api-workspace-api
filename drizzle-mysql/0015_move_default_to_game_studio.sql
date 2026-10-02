-- Everything created before teams existed (collected in the "Default" team by 0013) belongs to
-- Game Studio. Items, versions and runs follow their collection; personal `user` variables have no
-- team and are untouched. The emptied Default team is then removed; it never had members.
UPDATE `collections` SET `team_id` = '00000000-0000-4000-8000-000000000101' WHERE `team_id` = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
UPDATE `environments` SET `team_id` = '00000000-0000-4000-8000-000000000101' WHERE `team_id` = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
UPDATE `variables` SET `team_id` = '00000000-0000-4000-8000-000000000101' WHERE `team_id` = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
DELETE FROM `teams` WHERE `id` = '00000000-0000-4000-8000-000000000001';
