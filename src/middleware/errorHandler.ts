import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError, NotFoundError } from "../errors.js";

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
};

export interface ErrorHandlerOptions {
  exposeInternalErrors?: boolean;
  logger?: (err: unknown) => void;
}

export function createErrorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  const { exposeInternalErrors = false, logger = (err) => console.error(err) } = options;

  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    let status = 500;
    let body: ErrorResponseBody;

    if (err instanceof HttpError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, details: err.details } };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: err.issues } };
    } else if (isSqliteUniqueViolation(err)) {
      status = 409;
      body = { error: { code: "CONFLICT", message: "The change conflicts with existing data" } };
    } else if (isBodyParserError(err)) {
      status = err.status;
      body = { error: { code: "BAD_REQUEST", message: err.expose ? err.message : "Bad request" } };
    } else {
      logger(err);
      body = {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: exposeInternalErrors && err instanceof Error ? err.message : "Internal server error",
        },
      };
    }

    res.status(status).json(body);
  };
}

function isBodyParserError(err: unknown): err is { status: number; expose?: boolean; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    (err as { status: number }).status >= 400 &&
    (err as { status: number }).status < 500
  );
}

function isSqliteUniqueViolation(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    (cause !== undefined && cause !== err && isSqliteUniqueViolation(cause))
  );
}
