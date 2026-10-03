import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, queryRows, type TestContext } from "../helpers.js";

let context: TestContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe("restoring owners of ownerless teams", () => {
  it("promotes the longest-standing member, preferring members over viewers", async () => {
    context = await createTestContext(":memory:", { authenticate: false });
    const run = (sql: string, params: unknown[] = []) => context!.db.$client.query(sql, params);
    const t = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

    await run(
      `INSERT INTO users (id, email, created_at) VALUES
        ('u-a', 'a@fluttersea.com', ?), ('u-b', 'b@fluttersea.com', ?), ('u-c', 'c@fluttersea.com', ?)`,
      [t(1), t(1), t(1)],
    );
    await run(
      `INSERT INTO teams (id, name, name_key, created_at, updated_at) VALUES
        ('t-orphan', 'Orphan', 'orphan', ?, ?), ('t-ok', 'Ok', 'ok', ?, ?), ('t-empty', 'Empty', 'empty', ?, ?)`,
      [t(1), t(1), t(1), t(1), t(1), t(1)],
    );
    await run(
      `INSERT INTO team_members (team_id, user_id, role, created_at) VALUES
        ('t-orphan', 'u-a', 'viewer', ?), ('t-orphan', 'u-b', 'member', ?), ('t-orphan', 'u-c', 'member', ?),
        ('t-ok', 'u-a', 'owner', ?), ('t-ok', 'u-b', 'member', ?)`,
      [t(1), t(3), t(2), t(1), t(1)],
    );

    const migration = readFileSync(new URL("../../drizzle-mysql/0019_restore_team_owners.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await run(statement);
    }

    const rows = await queryRows(
      context.db,
      "SELECT team_id, user_id, role FROM team_members WHERE team_id IN ('t-orphan','t-ok') ORDER BY team_id, user_id",
    );
    expect(rows.map((r) => `${r.team_id}/${r.user_id}/${r.role}`)).toEqual([
      "t-ok/u-a/owner",
      "t-ok/u-b/member",
      "t-orphan/u-a/viewer",
      "t-orphan/u-b/member",
      "t-orphan/u-c/owner",
    ]);
  });
});
