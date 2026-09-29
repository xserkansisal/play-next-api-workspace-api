import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  close: () => void;
}

export interface TestContextOptions {
  corsOrigin?: string;
  heartbeatMs?: number;
  retryMs?: number;
  replayBufferSize?: number;
}

export function createTestContext(path = ":memory:", options: TestContextOptions = {}): TestContext {
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
  return {
    db,
    app,
    events,
    api: request(app),
    close: () => {
      events.close();
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
