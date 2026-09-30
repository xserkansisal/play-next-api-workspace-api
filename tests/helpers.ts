import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import request from "supertest";
import type { Express } from "express";
import { loadEnv, type Env } from "../src/config/env.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase, type AppDatabase } from "../src/db/client.js";
import { ChangeEventHub } from "../src/events/hub.js";
import { MemoryEmailCodeSender } from "../src/auth/email.js";

export interface TestContext {
  db: AppDatabase;
  app: Express;
  events: ChangeEventHub;
  api: ReturnType<typeof request.agent>;
  unauthenticatedApi: ReturnType<typeof request>;
  emailSender: MemoryEmailCodeSender;
  sessionCookie: string;
  close: () => Promise<void>;
}

export interface TestContextOptions {
  corsOrigin?: string;
  heartbeatMs?: number;
  retryMs?: number;
  replayBufferSize?: number;
  authenticate?: boolean;
  env?: Partial<Env>;
}

export async function createTestContext(path = ":memory:", options: TestContextOptions = {}): Promise<TestContext> {
  const db = openDatabase(path);
  const events = new ChangeEventHub({ replayBufferSize: options.replayBufferSize });
  const envSource: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CORS_ORIGIN: options.corsOrigin,
    SSE_HEARTBEAT_MS: String(options.heartbeatMs ?? 60_000),
    SSE_RETRY_MS: String(options.retryMs ?? 1_500),
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) envSource[key] = String(value);
  }
  const env = loadEnv(envSource);
  const emailSender = new MemoryEmailCodeSender();
  const app = createApp({
    env,
    db,
    events,
    emailCodeSender: emailSender,
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
  const api = request.agent(server);
  const unauthenticatedApi = request(server);
  let sessionCookie = "";
  if (options.authenticate !== false) {
    await unauthenticatedApi
      .post("/api/v1/auth/request-code")
      .send({ email: "test@sisal.com" })
      .expect(202);
    const message = emailSender.getMessage("test@sisal.com");
    if (!message) throw new Error("Test email sender did not retain the requested code");
    const login = await api
      .post("/api/v1/auth/verify-code")
      .send({ email: message.to, code: message.code })
      .expect(200);
    const setCookie = login.headers["set-cookie"]?.[0];
    if (!setCookie) throw new Error("Sign-in did not issue a session cookie");
    sessionCookie = setCookie.split(";", 1)[0]!;
  }
  return {
    db,
    app,
    events,
    api,
    unauthenticatedApi,
    emailSender,
    sessionCookie,
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
