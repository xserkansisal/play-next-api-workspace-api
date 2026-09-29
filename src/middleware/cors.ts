import type { RequestHandler } from "express";

export function createCorsMiddleware(allowedOrigin?: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("Origin");
    if (origin) res.vary("Origin");

    if (!allowedOrigin || origin !== allowedOrigin) {
      next();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
