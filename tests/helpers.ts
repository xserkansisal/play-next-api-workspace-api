import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase, type AppDatabase } from "../src/db/client.js";

export interface TestContext {
  db: AppDatabase;
  app: Express;
  api: ReturnType<typeof request>;
  close: () => void;
}

export function createTestContext(path = ":memory:"): TestContext {
  const db = openDatabase(path);
  const app = createApp({ env: { NODE_ENV: "test" }, db, logger: () => {} });
  return { db, app, api: request(app), close: () => closeDatabase(db) };
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
