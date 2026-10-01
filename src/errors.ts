export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = "HTTP_ERROR",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Resource not found", code = "NOT_FOUND") {
    super(404, message, code);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code = "BAD_REQUEST", details?: unknown) {
    super(400, message, code, details);
    this.name = "BadRequestError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, code = "CONFLICT", details?: unknown) {
    super(409, message, code, details);
    this.name = "ConflictError";
  }
}
