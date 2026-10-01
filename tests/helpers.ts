import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createConnection, type RowDataPacket } from "mysql2/promise";
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
  emailSender?: MemoryEmailCodeSender;
  logger?: (err: unknown) => void;
}

function databaseName(path: string): string {
  const suffix = path === ":memory:" ? randomUUID().replaceAll("-", "") : createHash("sha256").update(path).digest("hex").slice(0, 24);
  return `play_next_api_test_${suffix}`;
}

function mysqlTestConfig() {
  return {
    host: process.env.MYSQL_TEST_HOST ?? process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_TEST_PORT ?? process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_TEST_USER ?? process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_TEST_PASSWORD ?? process.env.MYSQL_PASSWORD ?? "",
  };
}

async function provisionTestDatabase(name: string): Promise<void> {
  const connection = await createConnection(mysqlTestConfig());
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  } finally {
    await connection.end();
  }
}

export async function dropTestDatabase(path: string): Promise<void> {
  await dropDatabase(databaseName(path));
}

async function dropDatabase(name: string): Promise<void> {
  const connection = await createConnection(mysqlTestConfig());
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await connection.end();
  }
}

export async function createTestContext(path = ":memory:", options: TestContextOptions = {}): Promise<TestContext> {
  const database = databaseName(path);
  await provisionTestDatabase(database);
  const envSource: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CORS_ORIGIN: options.corsOrigin,
    SSE_HEARTBEAT_MS: String(options.heartbeatMs ?? 60_000),
    SSE_RETRY_MS: String(options.retryMs ?? 1_500),
    MYSQL_HOST: mysqlTestConfig().host,
    MYSQL_PORT: String(mysqlTestConfig().port),
    MYSQL_USER: mysqlTestConfig().user,
    MYSQL_PASSWORD: mysqlTestConfig().password,
    MYSQL_DATABASE: database,
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) envSource[key] = String(value);
  }
  const env = loadEnv(envSource);
  const db = await openDatabase(env);
  const events = new ChangeEventHub({ replayBufferSize: options.replayBufferSize });
  const emailSender = options.emailSender ?? new MemoryEmailCodeSender();
  const app = createApp({
    env,
    db,
    events,
    emailCodeSender: emailSender,
    logger: options.logger ?? (() => {}),
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
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        await closeDatabase(db);
        if (path === ":memory:") await dropDatabase(database);
      }
    },
  };
}

export function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "play-next-api-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function queryRows(db: AppDatabase, query: string, parameters: unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.$client.query<RowDataPacket[]>(query, parameters);
  return rows;
}

export async function executeSql(db: AppDatabase, query: string): Promise<void> {
  await db.$client.query(query);
}

export const requestFields = {
  method: "GET",
  url: "{{baseUrl}}/api",
  queryParams: [],
  headers: [],
  body: null,
  auth: { type: "none" },
};
