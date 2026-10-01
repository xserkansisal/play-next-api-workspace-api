ALTER TABLE `users` ADD `first_name` varchar(320) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_name` varchar(320) DEFAULT '' NOT NULL;--> statement-breakpoint
-- Existing non-empty names are retained. To roll back, drop both columns; the derived backfill
-- is not reversible, so take a database backup first if these values may have been edited later.
WITH RECURSIVE normalized_users AS (
  SELECT
    `id`,
    CASE
      WHEN INSTR(`email`, '@') > 1
        THEN TRIM(BOTH '.' FROM REGEXP_REPLACE(SUBSTRING_INDEX(`email`, '@', 1), '[.]+', '.'))
      ELSE ''
    END AS `local_part`
  FROM `users`
),
all_parts AS (
  SELECT
    `id`,
    `local_part`,
    1 AS `part_no`,
    TRIM(SUBSTRING_INDEX(`local_part`, '.', 1)) AS `part`
  FROM normalized_users
  WHERE `local_part` <> ''
  UNION ALL
  SELECT
    `id`,
    `local_part`,
    `part_no` + 1,
    TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(`local_part`, '.', `part_no` + 1), '.', -1))
  FROM all_parts
  WHERE `part_no` <= LENGTH(`local_part`) - LENGTH(REPLACE(`local_part`, '.', ''))
),
name_parts AS (
  SELECT `id`, `part_no`, `part`
  FROM all_parts
  WHERE `part` <> ''
),
derived_names AS (
  SELECT
    `id`,
    MAX(CASE
      WHEN `part_no` = 1 THEN CONCAT(UPPER(LEFT(`part`, 1)), SUBSTRING(`part`, 2))
    END) AS `first_name`,
    COALESCE(GROUP_CONCAT(
      CASE
        WHEN `part_no` > 1 THEN CONCAT(UPPER(LEFT(`part`, 1)), SUBSTRING(`part`, 2))
      END
      ORDER BY `part_no` SEPARATOR ' '
    ), '') AS `last_name`
  FROM name_parts
  GROUP BY `id`
)
UPDATE `users` AS `u`
LEFT JOIN derived_names AS `n` ON `n`.`id` = `u`.`id`
SET
  `u`.`first_name` = CASE WHEN `u`.`first_name` = '' THEN COALESCE(`n`.`first_name`, '') ELSE `u`.`first_name` END,
  `u`.`last_name` = CASE WHEN `u`.`last_name` = '' THEN COALESCE(`n`.`last_name`, '') ELSE `u`.`last_name` END
WHERE `u`.`first_name` = '' OR `u`.`last_name` = '';