import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { createUserRateLimit } from "../../src/middleware/rateLimit.js";
import { importItemsSchema, MAX_TREE_DEPTH, measureImportShape } from "../../src/validation/schemas.js";

function nested(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "request", name: "Leaf", method: "GET", url: "/" };
  for (let i = 0; i < levels - 1; i += 1) node = { type: "folder", name: `L${i}`, items: [node] };
  return node;
}

describe("importItemsSchema", () => {
  it("applies defaults", () => {
    const parsed = importItemsSchema.parse({ items: [{ type: "folder", name: " Auth " }] });
    expect(parsed).toEqual({
      parentId: null,
      onConflict: "rename",
      dryRun: false,
      items: [{ type: "folder", name: "Auth", description: "", items: [] }],
    });
  });

  it("rejects an empty import, unknown fields and unsupported conflict modes", () => {
    expect(importItemsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(importItemsSchema.safeParse({ items: [nested(1)], extra: true }).success).toBe(false);
    expect(importItemsSchema.safeParse({ items: [nested(1)], onConflict: "merge" }).success).toBe(false);
    expect(importItemsSchema.safeParse({ items: [{ ...nested(1), id: "x" }] }).success).toBe(false);
  });

  it("enforces the maximum depth", () => {
    expect(importItemsSchema.safeParse({ items: [nested(MAX_TREE_DEPTH)] }).success).toBe(true);
    expect(importItemsSchema.safeParse({ items: [nested(MAX_TREE_DEPTH + 1)] }).success).toBe(false);
  });
});

describe("measureImportShape", () => {
  it("counts nodes and depth of a raw body", () => {
    expect(measureImportShape({ items: [nested(3), nested(1)] })).toEqual({ nodes: 4, depth: 3 });
    expect(measureImportShape(null)).toEqual({ nodes: 0, depth: 0 });
    expect(measureImportShape({ items: "nope" })).toEqual({ nodes: 0, depth: 0 });
  });

  it("handles hostile nesting without recursion and stops past the limit", () => {
    const shape = measureImportShape({ items: [nested(100_000)] });
    expect(shape.depth).toBe(MAX_TREE_DEPTH + 1);
  });
});

describe("createUserRateLimit", () => {
  function call(handler: ReturnType<typeof createUserRateLimit>, userId: string) {
    const result: { status?: number; headers: Record<string, string>; next: boolean } = { headers: {}, next: false };
    const res = {
      status(code: number) {
        result.status = code;
        return this;
      },
      set(name: string, value: string) {
        result.headers[name] = value;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    handler({ authUser: { id: userId } } as unknown as Request, res, () => {
      result.next = true;
    });
    return result;
  }

  it("allows the limit per user per window, then answers 429", () => {
    let now = 0;
    const limit = createUserRateLimit({ limit: 2, windowMs: 60_000, now: () => now });
    expect(call(limit, "a").next).toBe(true);
    expect(call(limit, "a").next).toBe(true);
    const blocked = call(limit, "a");
    expect(blocked).toMatchObject({ next: false, status: 429, headers: { "Retry-After": "60" } });
    expect(call(limit, "b").next).toBe(true);
    now = 60_000;
    expect(call(limit, "a").next).toBe(true);
  });
});
