import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, queryRows, type TestContext } from "../helpers.js";

const DEFAULT_TEAM = "00000000-0000-4000-8000-000000000001";
const GAME_STUDIO = "00000000-0000-4000-8000-000000000101";

let context: TestContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe("moving pre-team resources to Game Studio", () => {
  it("reassigns every collection, environment and global variable and removes the Default team", async () => {
    context = await createTestContext(":memory:", { authenticate: false });
    const db = context.db;
    const now = new Date().toISOString();
    // Recreate the state 0013 leaves behind: the old data in a memberless Default team.
    await db.$client.query(
      "INSERT INTO teams (id, name, name_key, description, created_at, updated_at) VALUES (?, 'Default', 'default', '', ?, ?)",
      [DEFAULT_TEAM, now, now],
    );
    await db.$client.query(
      `INSERT INTO collections (id, team_id, name, name_key, description, created_at, updated_at, deleted_at) VALUES
        ('c-active', ?, 'Legacy', 'legacy', '', ?, ?, NULL),
        ('c-trashed', ?, 'Old', 'old', '', ?, ?, ?)`,
      [DEFAULT_TEAM, now, now, DEFAULT_TEAM, now, now, now],
    );
    await db.$client.query(
      "INSERT INTO environments (id, team_id, name, name_key, created_at, updated_at) VALUES ('e-1', ?, 'Staging', 'staging', ?, ?)",
      [DEFAULT_TEAM, now, now],
    );
    await db.$client.query(
      "INSERT INTO users (id, email, created_at) VALUES ('u-1', 'legacy.user@sisal.com', ?)",
      [now],
    );
    await db.$client.query(
      `INSERT INTO variables (id, scope, user_id, team_id, \`key\`, value, created_at, updated_at) VALUES
        ('v-global', 'global', NULL, ?, 'host', 'h', ?, ?),
        ('v-user', 'user', 'u-1', NULL, 'token', 't', ?, ?)`,
      [DEFAULT_TEAM, now, now, now, now],
    );

    const migration = readFileSync(new URL("../../drizzle-mysql/0015_move_default_to_game_studio.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await db.$client.query(statement);
    }

    const owners = await queryRows(
      db,
      `SELECT id, team_id FROM collections UNION ALL SELECT id, team_id FROM environments
       UNION ALL SELECT id, team_id FROM variables ORDER BY id`,
    );
    expect(owners.map((row) => [row.id, row.team_id])).toEqual([
      ["c-active", GAME_STUDIO],
      ["c-trashed", GAME_STUDIO],
      ["e-1", GAME_STUDIO],
      ["v-global", GAME_STUDIO],
      ["v-user", null],
    ]);
    expect(await queryRows(db, "SELECT id FROM teams WHERE id = ?", [DEFAULT_TEAM])).toEqual([]);
  });
});
