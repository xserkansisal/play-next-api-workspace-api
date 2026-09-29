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
  constructor(message = "Resource not found") {
    super(404, message, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}
