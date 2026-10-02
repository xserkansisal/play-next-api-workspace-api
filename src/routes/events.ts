import { Router, type Response } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub, SequencedChangeEvent } from "../events/hub.js";
import type { PresenceHub, PresenceSnapshot } from "../events/presence.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";

export interface EventsRouterOptions {
  heartbeatMs: number;
  retryMs: number;
  /** Disconnect a client whose unsent buffer exceeds this many bytes. */
  maxBufferedBytes?: number;
}

function formatEvent(event: SequencedChangeEvent): string {
  const { eventId, ...payload } = event;
  return `id: ${eventId}\nevent: change\ndata: ${JSON.stringify(payload)}\n\n`;
}

function formatPresence(snapshot: PresenceSnapshot): string {
  return `event: presence\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function createEventsRouter(
  hub: ChangeEventHub,
  presence: PresenceHub,
  db: AppDatabase,
  options: EventsRouterOptions,
): Router {
  const router = Router();
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_000_000;

  router.get("/", async (req, res: Response, next) => {
    try {
      // One stream watches one team; switching teams means opening a new stream.
      const subscriber = { userId: authenticatedUserId(req), teamId: requestTeamId(req) };
      if (hub.isClosed) {
        res.status(503).set("Retry-After", String(Math.ceil(options.retryMs / 1000))).end();
        return;
      }
      await presence.removeInactiveResources(db);
      res.status(200).set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);
      req.socket.setTimeout(0);

      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;
      let unsubscribe = () => {};
      let unsubscribePresence = () => {};
      let offClose = () => {};
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribePresence();
        offClose();
      };
      const end = () => {
        cleanup();
        res.end();
      };
      const write = (chunk: string) => {
        if (closed) return;
        res.write(chunk);
        if (res.writableLength > maxBufferedBytes) end();
      };

      write(`retry: ${options.retryMs}\n\n`);
      const lastEventId =
        req.get("Last-Event-ID") ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined);
      if (lastEventId) {
        const replay = hub.replaySince(lastEventId, subscriber);
        if (replay.complete) {
          for (const event of replay.events) write(formatEvent(event));
        } else {
          // The client may have missed changes (restart or buffer overflow); it should refetch.
          write(`event: resync\ndata: ${JSON.stringify({ reason: "history_unavailable" })}\n\n`);
        }
      }
      write(`event: ready\ndata: ${JSON.stringify({ epoch: hub.epoch })}\n\n`);

      if (closed) return;

      // Replay and subscribe run in the same synchronous turn, so no event can fall between them.
      // Revoked when the user leaves the team or the team is archived.
      unsubscribe = hub.subscribe((event) => write(formatEvent(event)), subscriber, end);
      write(formatPresence(presence.snapshot(subscriber.teamId)));
      if (closed) return;
      unsubscribePresence = presence.subscribe(subscriber.teamId, (snapshot) => write(formatPresence(snapshot)));
      heartbeat = setInterval(() => write(`: heartbeat ${new Date().toISOString()}\n\n`), options.heartbeatMs);
      heartbeat.unref();
      offClose = hub.onClose(end);
      req.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
