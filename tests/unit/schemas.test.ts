import { describe, expect, it } from "vitest";
import { createCollectionSchema, createItemSchema, environmentInputSchema, restoreSchema } from "../../src/validation/schemas.js";
import { compareByName, nameKey } from "../../src/services/common.js";

describe("validation schemas", () => {
  it("applies request defaults and trims names", () => {
    const parsed = createItemSchema.parse({ type: "request", name: "  List  ", method: "GET", url: "/x" });
    expect(parsed).toEqual({
      type: "request",
      name: "List",
      parentId: null,
      description: "",
      method: "GET",
      url: "/x",
      queryParams: [],
      headers: [],
      body: null,
      auth: { type: "none" },
    });
  });

  it("parses recursive collection trees", () => {
    const parsed = createCollectionSchema.parse({
      name: "C",
      items: [{ type: "folder", name: "A", items: [{ type: "folder", name: "B" }] }],
    });
    expect(parsed.items[0]).toMatchObject({ type: "folder", items: [{ type: "folder", name: "B", items: [] }] });
  });

  it("limits folder nesting depth", () => {
    let node: Record<string, unknown> = { type: "folder", name: "leaf" };
    for (let i = 0; i < 40; i++) node = { type: "folder", name: `f${i}`, items: [node] };
    expect(createCollectionSchema.safeParse({ name: "Deep", items: [node] }).success).toBe(false);
  });

  it("reports duplicate environment variable keys with a path", () => {
    const result = environmentInputSchema.safeParse({ name: "E", variables: [{ key: "a", value: "" }, { key: "a", value: "" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["variables", 1, "key"]);
  });

  it("defaults restore input when omitted", () => {
    expect(restoreSchema.parse(undefined)).toEqual({ nameOverrides: {} });
  });
});

describe("name helpers", () => {
  it("compares names case-insensitively, including non-ASCII", () => {
    expect(nameKey("ÇAĞ Ürün")).toBe(nameKey("çağ ürün"));
    expect(nameKey("Cafe\u0301")).toBe(nameKey("CAFÉ"));
    const sorted = [{ id: "1", name: "beta" }, { id: "2", name: "Alpha" }, { id: "3", name: "alpha" }].sort(compareByName);
    expect(sorted.map((s) => s.id)).toEqual(["2", "3", "1"]);
  });
});
