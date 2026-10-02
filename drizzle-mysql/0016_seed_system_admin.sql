-- The first system admin. The account is created if it does not exist yet (without a session);
-- an existing account keeps its id and profile and is only promoted. Further admins are granted
-- from the admin panel, and ADMIN_EMAILS keeps working as an additional bootstrap.
INSERT IGNORE INTO `users` (`id`, `email`, `first_name`, `last_name`, `created_at`)
VALUES (UUID(), 'serkan.taghan@fluttersea.com', 'Serkan', 'Taghan', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z'));--> statement-breakpoint
UPDATE `users` SET `system_role` = 'admin' WHERE `email` = 'serkan.taghan@fluttersea.com';
