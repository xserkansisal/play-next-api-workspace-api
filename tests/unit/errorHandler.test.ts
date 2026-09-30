import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "../../src/errors.js";
import { createErrorHandler } from "../../src/middleware/errorHandler.js";

function mockResponse(headersSent = false) {
  const res = { headersSent, status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function run(err: unknown, options: Parameters<typeof createErrorHandler>[0] = {}, headersSent = false) {
  const res = mockResponse(headersSent);
  const next = vi.fn();
  createErrorHandler({ logger: () => {}, ...options })(err, {} as Request, res as unknown as Response, next as NextFunction);
  return { res, next };
}

describe("createErrorHandler", () => {
  it("maps HttpError to its status and code", () => {
    const { res } = run(new HttpError(409, "Conflict", "CONFLICT"));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: { code: "CONFLICT", message: "Conflict", details: undefined } });
  });

  it("maps ZodError to a 400 validation error", () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    const { res } = run(parsed.error);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0]?.[0].error.code).toBe("VALIDATION_ERROR");
  });

  it("hides internal error messages unless exposed", () => {
    const logger = vi.fn();
    const hidden = run(new Error("boom"), { logger });
    expect(hidden.res.status).toHaveBeenCalledWith(500);
    expect(hidden.res.json).toHaveBeenCalledWith({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
    });
    expect(logger).toHaveBeenCalledOnce();

    const exposed = run(new Error("boom"), { exposeInternalErrors: true });
    expect(exposed.res.json.mock.calls[0]?.[0].error.message).toBe("boom");
  });

  it("delegates to next when headers were already sent", () => {
    const err = new Error("late");
    const { res, next } = run(err, {}, true);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
