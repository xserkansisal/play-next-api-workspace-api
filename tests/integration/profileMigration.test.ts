import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe("user profile migration", () => {
  it("backfills legacy users and preserves non-empty values when the backfill is repeated", async () => {
    context = await createTestContext(":memory:", { authenticate: false });
    const table = "users_profile_migration_test";
    await context.db.$client.query(`
      CREATE TABLE \`${table}\` (
        id varchar(36) NOT NULL PRIMARY KEY,
        email varchar(320) NOT NULL UNIQUE,
        created_at varchar(24) NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin
    `);
    await context.db.$client.query(
      `INSERT INTO \`${table}\` (id, email, created_at) VALUES
        ('ada', '..ada...marie..lovelace..@example.com', '2026-01-01T00:00:00.000Z'),
        ('single', 'serkan@sisal.com', '2026-01-01T00:00:00.000Z'),
        ('invalid', 'legacy-address', '2026-01-01T00:00:00.000Z')`,
    );

    const migration = readFileSync(new URL("../../drizzle-mysql/0004_spooky_trish_tilby.sql", import.meta.url), "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => statement.replaceAll("`users`", `\`${table}\``));
    for (const statement of statements) await context.db.$client.query(statement);

    const [rows] = await context.db.$client.query(
      `SELECT id, first_name, last_name FROM \`${table}\` ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "ada", first_name: "Ada", last_name: "Marie Lovelace" },
      { id: "invalid", first_name: "", last_name: "" },
      { id: "single", first_name: "Serkan", last_name: "" },
    ]);

    await context.db.$client.query(`UPDATE \`${table}\` SET first_name = 'Kept', last_name = '' WHERE id = 'ada'`);
    const backfillStatement = statements.at(-1);
    if (!backfillStatement) throw new Error("Profile migration does not contain a backfill statement");
    await context.db.$client.query(backfillStatement);
    const [preservedRows] = await context.db.$client.query(
      `SELECT first_name, last_name FROM \`${table}\` WHERE id = 'ada'`,
    );
    expect(preservedRows).toEqual([{ first_name: "Kept", last_name: "Marie Lovelace" }]);
  });
});
