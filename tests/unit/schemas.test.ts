import { describe, expect, it } from "vitest";
import {
  createCollectionSchema,
  createItemSchema,
  environmentInputSchema,
  restoreSchema,
  variableDisplayOrderSchema,
  variableOrderPreferencesSchema,
} from "../../src/validation/schemas.js";
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
      auth: { type: "inherit" },
    });
  });

  it("parses recursive collection trees", () => {
    const parsed = createCollectionSchema.parse({
      name: "C",
      items: [{ type: "folder", name: "A", items: [{ type: "folder", name: "B" }] }],
    });
    expect(parsed.items[0]).toMatchObject({ type: "folder", items: [{ type: "folder", name: "B", items: [] }] });
  });

  it("accepts each supported request body type and preserves its content", () => {
    for (const type of ["json", "form-urlencoded", "multipart", "raw", "graphql"] as const) {
      const body = { type, content: "body content" };
      expect(createItemSchema.parse({ type: "request", name: "R", method: "POST", url: "/x", body })).toMatchObject({
        body,
      });
    }
    expect(
      createItemSchema.safeParse({
        type: "request",
        name: "R",
        method: "POST",
        url: "/x",
        body: { type: "form", content: "a=b" },
      }).success,
    ).toBe(false);
  });

  it("validates auth methods and permits inherited or scoped overrides", () => {
    const authModes = [
      { type: "inherit" },
      { type: "none" },
      { type: "basic", username: "user", password: "secret" },
      { type: "bearer", token: "secret" },
      { type: "api-key", in: "header", key: "X-API-Key", value: "secret" },
      { type: "api-key", in: "query", key: "api_key", value: "secret" },
    ];
    for (const auth of authModes) {
      expect(
        createItemSchema.parse({ type: "request", name: "R", method: "GET", url: "/x", auth }).auth,
      ).toEqual(auth);
    }

    expect(
      createItemSchema.safeParse({
        type: "request",
        name: "R",
        method: "GET",
        url: "/x",
        auth: { type: "api-key", in: "cookie", key: "key", value: "secret" },
      }).success,
    ).toBe(false);
    expect(
      createCollectionSchema.safeParse({
        name: "C",
        auth: { type: "inherit" },
      }).success,
    ).toBe(false);
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

  it("validates full variable display orders using variable key rules", () => {
    expect(variableDisplayOrderSchema.parse({ order: ["token", "environmentOnly"] })).toEqual({
      order: ["token", "environmentOnly"],
    });
    expect(variableDisplayOrderSchema.parse({ order: [] })).toEqual({ order: [] });
    expect(variableDisplayOrderSchema.safeParse({ order: ["token", " token "] }).success).toBe(false);
    expect(variableDisplayOrderSchema.safeParse({ order: ["two words"] }).success).toBe(false);
    expect(variableDisplayOrderSchema.safeParse({ order: ["{invalid}"] }).success).toBe(false);
    expect(variableDisplayOrderSchema.safeParse({ order: ["token"], extra: true }).success).toBe(false);
  });

  it("validates variable-order preferences while preserving extension fields", () => {
    const document = {
      version: 1,
      sort: { field: "value", direction: "desc", futureSortOption: true },
      manual: {
        user: ["token"],
        global: ["tenant"],
        environments: { "environment-id": ["host"] },
        futureGroup: ["later"],
      },
      updatedAt: "2026-10-01T11:20:00.000Z",
      futureDocumentField: { enabled: true },
    };
    expect(variableOrderPreferencesSchema.parse(document)).toEqual(document);
    expect(
      variableOrderPreferencesSchema.safeParse({
        ...document,
        sort: { field: "environment", direction: "desc" },
      }).success,
    ).toBe(false);
    expect(
      variableOrderPreferencesSchema.safeParse({
        ...document,
        manual: { ...document.manual, user: ["x".repeat(257)] },
      }).success,
    ).toBe(false);
    expect(
      variableOrderPreferencesSchema.safeParse({
        ...document,
        manual: { ...document.manual, global: Array.from({ length: 1001 }, () => "key") },
      }).success,
    ).toBe(false);
    expect(
      variableOrderPreferencesSchema.safeParse({
        ...document,
        manual: {
          ...document.manual,
          environments: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`env-${index}`, []])),
        },
      }).success,
    ).toBe(false);
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
