-- Teams left without an owner (e.g. after 0018 removed their owner) get their best remaining member
-- promoted: members before viewers, then the longest-standing, then by user id for determinism.
-- Teams with no members at all stay empty; a system administrator can still reach them.
UPDATE team_members tm
SET tm.role = 'owner'
WHERE NOT EXISTS (SELECT 1 FROM (SELECT team_id FROM team_members WHERE role = 'owner') o WHERE o.team_id = tm.team_id)
  AND tm.user_id = (
    SELECT c.user_id FROM (
      SELECT team_id, user_id, role, created_at FROM team_members
    ) c
    WHERE c.team_id = tm.team_id
    ORDER BY (c.role = 'member') DESC, c.created_at ASC, c.user_id ASC
    LIMIT 1
  );
