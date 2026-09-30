import { Router, type Response } from "express";
import type { ChangeEventHub, SequencedChangeEvent } from "../events/hub.js";

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

export function createEventsRouter(hub: ChangeEventHub, options: EventsRouterOptions): Router {
  const router = Router();
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_000_000;

  router.get("/", (req, res: Response) => {
    if (hub.isClosed) {
      res.status(503).set("Retry-After", String(Math.ceil(options.retryMs / 1000))).end();
      return;
    }
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
    let offClose = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
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
      const replay = hub.replaySince(lastEventId);
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
    unsubscribe = hub.subscribe((event) => write(formatEvent(event)));
    heartbeat = setInterval(() => write(`: heartbeat ${new Date().toISOString()}\n\n`), options.heartbeatMs);
    heartbeat.unref();
    offClose = hub.onClose(end);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  return router;
}
