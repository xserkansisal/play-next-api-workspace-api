import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, queryRows, type TestContext } from "../helpers.js";

const GAME_STUDIO = "00000000-0000-4000-8000-000000000101";

let context: TestContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe("removing accounts outside @fluttersea.com", () => {
  it("deletes them with what only they owned and keeps content they authored", async () => {
    context = await createTestContext(":memory:", { authenticate: false });
    const db = context.db;
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const run = (sql: string, params: unknown[] = []) => db.$client.query(sql, params);

    await run(
      `INSERT INTO users (id, email, created_at) VALUES
        ('u-old', 'old.person@sisal.com', ?), ('u-it', 'it.person@sisal.it', ?), ('u-keep', 'keep.person@fluttersea.com', ?)`,
      [now, now, now],
    );
    for (const user of ["u-old", "u-keep"]) {
      await run(
        "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        [`s-${user}`, user, `hash-${user}`, now, later],
      );
      await run("INSERT INTO team_members (team_id, user_id, role, created_at, added_by) VALUES (?, ?, 'member', ?, 'u-old')", [GAME_STUDIO, user, now]);
      await run("INSERT INTO user_preferences (user_id, name, value) VALUES (?, 'theme', '\"dark\"')", [user]);
      await run("INSERT INTO variable_display_orders (user_id, `order`) VALUES (?, '[]')", [user]);
      await run(
        "INSERT INTO variables (id, scope, user_id, team_id, `key`, value, created_at, updated_at) VALUES (?, 'user', ?, NULL, 'k', 'v', ?, ?)",
        [`v-${user}`, user, now, now],
      );
    }
    await run(
      `INSERT INTO collections (id, team_id, name, name_key, description, created_at, updated_at, created_by, updated_by)
       VALUES ('c-1', ?, 'Authored', 'authored', '', ?, ?, 'u-old', 'u-it')`,
      [GAME_STUDIO, now, now],
    );
    await run(
      "INSERT INTO variables (id, scope, user_id, team_id, `key`, value, created_at, updated_at, updated_by) VALUES ('v-g', 'global', NULL, ?, 'host', 'h', ?, ?, 'u-old')",
      [GAME_STUDIO, now, now],
    );
    await run(
      `INSERT INTO test_runs (id, collection_id, user_id, status, request_count, started_at)
       VALUES ('r-old', 'c-1', 'u-old', 'passed', 0, ?), ('r-keep', 'c-1', 'u-keep', 'passed', 0, ?)`,
      [now, now],
    );
    await run(
      `INSERT INTO auth_codes (id, email, code_hash, created_at, expires_at) VALUES
        ('a-old', 'old.person@sisal.com', 'x', ?, ?), ('a-keep', 'keep.person@fluttersea.com', 'x', ?, ?)`,
      [now, later, now, later],
    );
    await run(
      `INSERT INTO auth_rate_limits (email, purpose, window_started_at, attempts) VALUES
        ('old.person@sisal.com', 'request_code', ?, 1), ('keep.person@fluttersea.com', 'request_code', ?, 1)`,
      [now, now],
    );

    const migration = readFileSync(new URL("../../drizzle-mysql/0018_remove_non_fluttersea_users.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await run(statement);
    }

    const ids = async (sql: string) => (await queryRows(db, sql)).map((row) => Object.values(row)[0]);
    expect(await ids("SELECT id FROM users WHERE id IN ('u-old', 'u-it', 'u-keep') ORDER BY id")).toEqual(["u-keep"]);
    expect(await ids("SELECT id FROM auth_sessions WHERE id LIKE 's-%'")).toEqual(["s-u-keep"]);
    expect(await ids("SELECT id FROM test_runs ORDER BY id")).toEqual(["r-keep"]);
    expect(await ids("SELECT id FROM variables WHERE id LIKE 'v-%' ORDER BY id")).toEqual(["v-g", "v-u-keep"]);
    expect(await ids("SELECT user_id FROM user_preferences")).toEqual(["u-keep"]);
    expect(await ids("SELECT user_id FROM variable_display_orders")).toEqual(["u-keep"]);
    expect(await ids("SELECT id FROM auth_codes")).toEqual(["a-keep"]);
    expect(await ids("SELECT email FROM auth_rate_limits")).toEqual(["keep.person@fluttersea.com"]);
    expect(await ids("SELECT user_id FROM team_members WHERE user_id LIKE 'u-%'")).toEqual(["u-keep"]);

    expect(await queryRows(db, "SELECT created_by, updated_by FROM collections WHERE id = 'c-1'")).toEqual([
      { created_by: null, updated_by: null },
    ]);
    expect(await queryRows(db, "SELECT added_by FROM team_members WHERE user_id = 'u-keep'")).toEqual([{ added_by: null }]);
    expect(await queryRows(db, "SELECT updated_by FROM variables WHERE id = 'v-g'")).toEqual([{ updated_by: null }]);
    // Seeded fluttersea accounts, including the system admin, are untouched.
    expect(await ids("SELECT email FROM users WHERE email = 'serkan.taghan@fluttersea.com'")).toEqual(["serkan.taghan@fluttersea.com"]);
  });
});
