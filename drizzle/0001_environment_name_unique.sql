-- SQLite cannot add a NOT NULL column without a default; existing rows are backfilled below.
-- lower() is ASCII-only in SQLite; the application writes the Unicode-folded key for new saves.
ALTER TABLE `environments` ADD `name_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `environments` SET `name_key` = lower(`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `environments_active_name_unique` ON `environments` (`name_key`) WHERE "deleted_at" IS NULL;
