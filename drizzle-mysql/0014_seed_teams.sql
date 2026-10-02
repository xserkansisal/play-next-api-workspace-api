-- Initial teams, their admins and members. Safe to re-run against data entered by hand: an existing team
-- (matched by name) or user (matched by email) is reused, and existing memberships are untouched.
-- Admins who have never signed in get an account now, exactly as when an admin adds them in the
-- admin panel; their name follows the same email-derived rule as sign-in.
INSERT IGNORE INTO `teams` (`id`, `name`, `name_key`, `description`, `created_at`, `updated_at`) VALUES
  ('00000000-0000-4000-8000-000000000101', 'Game Studio', 'game studio', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  ('00000000-0000-4000-8000-000000000102', 'Mobile Gaming', 'mobile gaming', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  ('00000000-0000-4000-8000-000000000103', 'PAM', 'pam', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  ('00000000-0000-4000-8000-000000000104', 'Cross Module', 'cross module', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  ('00000000-0000-4000-8000-000000000105', 'Lottery', 'lottery', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  ('00000000-0000-4000-8000-000000000106', 'Hybrid App', 'hybrid app', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  ('00000000-0000-4000-8000-000000000107', 'Native App', 'native app', '', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'), DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'));--> statement-breakpoint
INSERT IGNORE INTO `users` (`id`, `email`, `first_name`, `last_name`, `created_at`) VALUES
  (UUID(), 'umit.cakir@fluttersea.com', 'Umit', 'Cakir', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'arman.kara@fluttersea.com', 'Arman', 'Kara', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'mertkan.yener@fluttersea.com', 'Mertkan', 'Yener', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'oguz.avci@fluttersea.com', 'Oguz', 'Avci', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'berk.yavuz@fluttersea.com', 'Berk', 'Yavuz', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'burak.akyol@fluttersea.com', 'Burak', 'Akyol', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'kubilay.aydin@fluttersea.com', 'Kubilay', 'Aydin', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'serkan.taghan@fluttersea.com', 'Serkan', 'Taghan', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'ali.ghadiri@fluttersea.com', 'Ali', 'Ghadiri', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'onur.ozuyguz@fluttersea.com', 'Onur', 'Ozuyguz', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'batuhan.munger@fluttersea.com', 'Batuhan', 'Munger', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')),
  (UUID(), 'hakan.toker@fluttersea.com', 'Hakan', 'Toker', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'));--> statement-breakpoint
INSERT IGNORE INTO `team_members` (`team_id`, `user_id`, `role`, `created_at`)
SELECT `t`.`id`, `u`.`id`, 'admin', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
FROM (
  SELECT 'game studio' AS `name_key`, 'umit.cakir@fluttersea.com' AS `email` UNION ALL
  SELECT 'mobile gaming' AS `name_key`, 'arman.kara@fluttersea.com' AS `email` UNION ALL
  SELECT 'pam' AS `name_key`, 'mertkan.yener@fluttersea.com' AS `email` UNION ALL
  SELECT 'cross module' AS `name_key`, 'oguz.avci@fluttersea.com' AS `email` UNION ALL
  SELECT 'lottery' AS `name_key`, 'berk.yavuz@fluttersea.com' AS `email` UNION ALL
  SELECT 'hybrid app' AS `name_key`, 'burak.akyol@fluttersea.com' AS `email` UNION ALL
  SELECT 'native app' AS `name_key`, 'kubilay.aydin@fluttersea.com' AS `email`
) AS `seed`
INNER JOIN `teams` AS `t` ON `t`.`name_key` = `seed`.`name_key`
INNER JOIN `users` AS `u` ON `u`.`email` = `seed`.`email`;--> statement-breakpoint
INSERT IGNORE INTO `team_members` (`team_id`, `user_id`, `role`, `created_at`)
SELECT `t`.`id`, `u`.`id`, 'member', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
FROM (
  SELECT 'serkan.taghan@fluttersea.com' AS `email` UNION ALL
  SELECT 'ali.ghadiri@fluttersea.com' AS `email` UNION ALL
  SELECT 'onur.ozuyguz@fluttersea.com' AS `email` UNION ALL
  SELECT 'batuhan.munger@fluttersea.com' AS `email` UNION ALL
  SELECT 'hakan.toker@fluttersea.com' AS `email`
) AS `seed`
INNER JOIN `teams` AS `t` ON `t`.`name_key` = 'game studio'
INNER JOIN `users` AS `u` ON `u`.`email` = `seed`.`email`;
