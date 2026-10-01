import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, queryRows, type TestContext } from "../helpers.js";

describe("MySQL database foundation", () => {
  let context: TestContext | undefined;

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it("connects to supported MySQL and applies the complete schema", async () => {
    context = await createTestContext();
    const rows = await queryRows(
      context.db,
      "SELECT VERSION() AS version, @@collation_database AS collation",
    );
    expect(String(rows[0]?.version)).toMatch(/^8\./);
    expect(rows[0]?.collation).toBe("utf8mb4_0900_bin");

    const tables = await queryRows(
      context.db,
      "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = DATABASE()",
    );
    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "auth_codes",
        "auth_rate_limits",
        "auth_sessions",
        "collections",
        "environment_variables",
        "environments",
        "items",
        "request_details",
        "request_headers",
        "request_query_params",
        "users",
        "variables",
      ]),
    );
  });
});
