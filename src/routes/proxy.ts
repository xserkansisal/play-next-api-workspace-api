import { Router } from "express";

import type { Env } from "../config/env.js";
import { allowsAnyHost, executeProxyRequest, parseAllowedHosts, proxyRequestSchema } from "../services/proxy.js";

export function createProxyRouter(env: Env): Router {
  const router = Router();
  const allowedHosts = parseAllowedHosts(env.PROXY_ALLOWED_HOSTS);
  const anyHost = allowsAnyHost(allowedHosts);

  /**
   * Lets the client show whether server-side execution is available, and which hosts it covers,
   * instead of only finding out by failing. `anyHost` is reported separately so the client can say
   * "every host" rather than printing a literal `*` and leaving the reader to guess. The list is
   * operator-set configuration, and every caller here is authenticated.
   */
  router.get("/", (_req, res) => {
    res.json({ enabled: allowedHosts.length > 0, anyHost, allowedHosts });
  });

  router.post("/", async (req, res, next) => {
    try {
      const result = await executeProxyRequest(proxyRequestSchema.parse(req.body), {
        allowedHosts,
        timeoutMs: env.PROXY_TIMEOUT_MS,
        maxResponseBytes: env.PROXY_MAX_RESPONSE_BYTES,
      });
      // The upstream status travels in the body, not in this response's status: a 404 from the
      // target is a successfully executed request, and collapsing the two would make an upstream
      // error indistinguishable from a proxy failure.
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
