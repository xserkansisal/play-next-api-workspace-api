import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importItemsSchema, measureImportShape, MAX_IMPORT_NODES } from "../../src/validation/schemas.js";

describe("skills/api-bulk-import/example.json", () => {
  it("is a valid import body", () => {
    const body: unknown = JSON.parse(readFileSync(new URL("../../skills/api-bulk-import/example.json", import.meta.url), "utf8"));
    expect(measureImportShape(body).nodes).toBeLessThanOrEqual(MAX_IMPORT_NODES);
    const parsed = importItemsSchema.parse(body);
    expect(parsed.items.length).toBeGreaterThan(0);
  });
});
