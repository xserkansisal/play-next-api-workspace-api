import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface SseFrame {
  event: string;
  id?: string;
  data?: string;
  retry?: number;
  comment?: string;
}

export interface SseClient {
  response: IncomingMessage;
  frames: SseFrame[];
  raw: () => string;
  changes: () => Array<Record<string, unknown> & { eventId?: string }>;
  waitFor: (predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number) => Promise<void>;
  ended: Promise<void>;
  close: () => void;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(app: Express): Promise<RunningServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function parseBlock(block: string): SseFrame | undefined {
  const frame: SseFrame = { event: "message" };
  let hasField = false;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      frame.event = "comment";
      hasField = true;
      continue;
    }
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
    hasField = true;
    if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    else if (field === "data") data.push(value);
    else if (field === "retry") {
      frame.retry = Number(value);
      frame.event = "retry";
    }
  }
  if (data.length > 0) frame.data = data.join("\n");
  return hasField ? frame : undefined;
}

export function connectSse(baseUrl: string, headers: Record<string, string> = {}, path = "/api/v1/events"): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, { headers: { Accept: "text/event-stream", ...headers } }, (response) => {
      const frames: SseFrame[] = [];
      let buffer = "";
      let rawText = "";
      const waiters = new Set<() => void>();
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        rawText += chunk;
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = parseBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (frame) frames.push(frame);
        }
        for (const w of [...waiters]) w();
      });
      const ended = new Promise<void>((done) => {
        response.on("end", done);
        response.on("close", done);
      });
      resolve({
        response,
        frames,
        raw: () => rawText,
        changes: () =>
          frames
            .filter((f) => f.event === "change")
            .map((f) => ({ ...(JSON.parse(f.data ?? "{}") as Record<string, unknown>), eventId: f.id })),
        waitFor: (predicate, timeoutMs = 2000) =>
          new Promise<void>((done, fail) => {
            if (predicate(frames)) return done();
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`Timed out waiting for SSE frames; got ${JSON.stringify(frames)}`));
            }, timeoutMs);
            const check = () => {
              if (predicate(frames)) {
                clearTimeout(timer);
                waiters.delete(check);
                done();
              }
            };
            waiters.add(check);
          }),
        ended,
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await sleep(5);
  }
}
