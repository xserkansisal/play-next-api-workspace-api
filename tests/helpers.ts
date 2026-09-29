import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase, type AppDatabase } from "../src/db/client.js";
import { ChangeEventHub } from "../src/events/hub.js";

export interface TestContext {
  db: AppDatabase;
  app: Express;
  events: ChangeEventHub;
  api: ReturnType<typeof request>;
  close: () => Promise<void>;
}

export interface TestContextOptions {
  corsOrigin?: string;
  heartbeatMs?: number;
  retryMs?: number;
  replayBufferSize?: number;
}

export async function createTestContext(path = ":memory:", options: TestContextOptions = {}): Promise<TestContext> {
  const db = openDatabase(path);
  const events = new ChangeEventHub({ replayBufferSize: options.replayBufferSize });
  const app = createApp({
    env: {
      NODE_ENV: "test",
      CORS_ORIGIN: options.corsOrigin,
      SSE_HEARTBEAT_MS: options.heartbeatMs ?? 60_000,
      SSE_RETRY_MS: options.retryMs ?? 1_500,
    },
    db,
    events,
    logger: () => {},
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    db,
    app,
    events,
    api: request(server),
    close: async () => {
      events.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      closeDatabase(db);
    },
  };
}

export function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "play-next-api-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const requestFields = {
  method: "GET",
  url: "{{baseUrl}}/api",
  queryParams: [],
  headers: [],
  body: null,
  auth: { type: "none" },
};
