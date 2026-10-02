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
import { ChangeEventHub, type SequencedChangeEvent } from "../src/events/hub.js";
import { PresenceHub } from "../src/events/presence.js";
import { MemoryEmailCodeSender } from "../src/auth/email.js";

export interface TestContext {
  db: AppDatabase;
  app: Express;
  events: ChangeEventHub;
  presence: PresenceHub;
  api: ReturnType<typeof request.agent>;
  unauthenticatedApi: ReturnType<typeof request>;
  emailSender: MemoryEmailCodeSender;
  sessionCookie: string;
  /** The seeded Game Studio team; the signed-in test user is added to it as an owner. */
  teamId: string;
  /** Listens to the change stream as an outside member of the default team would. */
  subscribe: (listener: (event: SequencedChangeEvent) => void) => () => void;
  close: () => Promise<void>;
}

export const DEFAULT_TEAM_ID = "00000000-0000-4000-8000-000000000101";

/** Adds a user to a team directly, bypassing the admin API. */
export async function addTeamMembership(
  db: AppDatabase,
  email: string,
  teamId = DEFAULT_TEAM_ID,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await db.$client.query(
    `INSERT IGNORE INTO team_members (team_id, user_id, role, created_at)
     SELECT ?, id, ?, ? FROM users WHERE email = ?`,
    [teamId, role, new Date().toISOString(), email],
  );
}

/** Creates a team directly, bypassing the admin API, and returns its id. */
export async function createTeamRow(db: AppDatabase, name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.$client.query(
    "INSERT INTO teams (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
    [id, name, name.toLowerCase(), now, now],
  );
  return id;
}

export interface TestContextOptions {
  corsOrigin?: string;
  heartbeatMs?: number;
  retryMs?: number;
  replayBufferSize?: number;
  presenceTtlMs?: number;
  presenceSweepIntervalMs?: number;
  authenticate?: boolean;
  env?: Partial<Env>;
  emailSender?: MemoryEmailCodeSender;
  logger?: (err: unknown) => void;
  collections?: import("../src/routes/collections.js").CollectionsRouterOptions;
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
  const presence = new PresenceHub({
    ttlMs: options.presenceTtlMs,
    sweepIntervalMs: options.presenceSweepIntervalMs,
  });
  const emailSender = options.emailSender ?? new MemoryEmailCodeSender();
  const app = createApp({
    env,
    db,
    events,
    presence,
    emailCodeSender: emailSender,
    logger: options.logger ?? (() => {}),
    collections: options.collections,
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
    await addTeamMembership(db, "test@sisal.com", DEFAULT_TEAM_ID, "owner");
  }
  return {
    db,
    app,
    events,
    presence,
    api,
    unauthenticatedApi,
    emailSender,
    sessionCookie,
    teamId: DEFAULT_TEAM_ID,
    subscribe: (listener) => events.subscribe(listener, { userId: "test-observer", teamId: DEFAULT_TEAM_ID }),
    close: async () => {
      events.close();
      presence.close();
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
  auth: { type: "inherit" },
  preRequestScript: "",
  postResponseScript: "",
};
