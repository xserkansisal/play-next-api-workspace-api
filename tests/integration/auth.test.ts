import { afterEach, describe, expect, it } from "vitest";
import { connectSse, startServer } from "../sse.js";
import { createTestContext, type TestContext } from "../helpers.js";
import { MemoryEmailCodeSender } from "../../src/auth/email.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup(options: Parameters<typeof createTestContext>[1] = {}) {
  ctx = await createTestContext(":memory:", { authenticate: false, ...options });
  return ctx;
}

async function issueCode(context: TestContext, email = "person@sisal.com") {
  await context.unauthenticatedApi.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = context.emailSender.getMessage(email);
  if (!message) throw new Error("Test sender did not retain sign-in code");
  return message;
}

function verify(context: TestContext, email: string, code: string) {
  return context.unauthenticatedApi.post("/api/v1/auth/verify-code").send({ email, code });
}

function cookieValue(setCookie: string): string {
  return decodeURIComponent(setCookie.split(";", 1)[0]!.split("=", 2)[1]!);
}

function setCookieHeader(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers["set-cookie"];
  if (!Array.isArray(cookies) || typeof cookies[0] !== "string") throw new Error("Sign-in did not set a session cookie");
  return cookies[0];
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

describe("email code sign-in", () => {
  it("allows only the configured domains and keeps request responses uniform", async () => {
    const context = await setup();
    for (const email of ["dev@fluttersea.com", "dev@sisal.com", "dev@sisal.it"]) {
      const response = await context.unauthenticatedApi.post("/api/v1/auth/request-code").send({ email }).expect(202);
      expect(response.body).toEqual({ message: "If the address is eligible, a sign-in code has been sent." });
    }
    for (const email of ["dev@example.com", "dev@sub.sisal.com"]) {
      const response = await context.unauthenticatedApi.post("/api/v1/auth/request-code").send({ email }).expect(400);
      expect(response.body.error.code).toBe("EMAIL_DOMAIN_NOT_ALLOWED");
    }
  });

  it("returns the same code-request response for an existing and a new account", async () => {
    const context = await setup();
    const existing = await issueCode(context, "existing@sisal.com");
    await verify(context, existing.to, existing.code).expect(200);
    const existingResponse = await context.unauthenticatedApi
      .post("/api/v1/auth/request-code")
      .send({ email: existing.to })
      .expect(202);
    const newResponse = await context.unauthenticatedApi
      .post("/api/v1/auth/request-code")
      .send({ email: "new@sisal.com" })
      .expect(202);
    expect(existingResponse.body).toEqual(newResponse.body);
  });

  it("stores only a keyed code hash and returns the configured 15-minute expiry", async () => {
    const context = await setup();
    const message = await issueCode(context, "hash@sisal.com");
    const row = context.db.$client.prepare("SELECT code_hash, expires_at FROM auth_codes WHERE email = ?").get("hash@sisal.com") as {
      code_hash: string;
      expires_at: string;
    };
    const codeColumns = context.db.$client.prepare("PRAGMA table_info(auth_codes)").all() as Array<{ name: string }>;
    const issuedAt = context.db.$client.prepare("SELECT created_at FROM auth_codes WHERE email = ?").get("hash@sisal.com") as {
      created_at: string;
    };
    expect(row.code_hash).not.toContain(message.code);
    expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(codeColumns.map(({ name }) => name)).toContain("code_hash");
    expect(codeColumns.map(({ name }) => name)).not.toContain("code");
    expect(Date.parse(row.expires_at) - Date.parse(message.expiresAt)).toBe(0);
    expect(Date.parse(row.expires_at) - Date.parse(issuedAt.created_at)).toBe(900_000);
  });

  it("rejects expired and already-used codes", async () => {
    const context = await setup();
    const expired = await issueCode(context, "expired@sisal.com");
    context.db.$client.prepare("UPDATE auth_codes SET expires_at = ? WHERE email = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      expired.to,
    );
    await verify(context, expired.to, expired.code).expect(401);

    const current = await issueCode(context, "single@sisal.com");
    await verify(context, current.to, current.code).expect(200);
    await verify(context, current.to, current.code).expect(401);
  });

  it("deadens a code after five incorrect attempts", async () => {
    const context = await setup();
    const message = await issueCode(context, "attempts@sisal.com");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verify(context, message.to, message.code === "000000" ? "000001" : "000000").expect(401);
    }
    await verify(context, message.to, message.code).expect(401);
  });

  it("rate limits code requests and verification per normalized email", async () => {
    const context = await setup({
      env: {
        AUTH_CODE_REQUEST_LIMIT: 2,
        AUTH_CODE_VERIFY_LIMIT: 2,
      },
    });
    const email = "limits@sisal.com";
    await context.unauthenticatedApi.post("/api/v1/auth/request-code").send({ email }).expect(202);
    await context.unauthenticatedApi.post("/api/v1/auth/request-code").send({ email: email.toUpperCase() }).expect(202);
    await context.unauthenticatedApi.post("/api/v1/auth/request-code").send({ email }).expect(429);

    const other = "verify-limits@sisal.com";
    const message = await issueCode(context, other);
    await verify(context, other, "000000").expect(401);
    await verify(context, other, "000000").expect(401);
    await verify(context, other, message.code).expect(429);
  });

  it("creates one-month revocable sessions and signs out", async () => {
    const context = await setup();
    const message = await issueCode(context);
    const response = await verify(context, message.to, message.code).expect(200);
    expect(response.body.user.email).toBe(message.to);
    expect(Date.parse(response.body.expiresAt) - Date.now()).toBeGreaterThan(2_591_000_000);
    expect(Date.parse(response.body.expiresAt) - Date.now()).toBeLessThanOrEqual(2_592_000_000);
    const setCookie = setCookieHeader(response);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    const token = cookieValue(setCookie);
    const stored = context.db.$client.prepare("SELECT token_hash FROM auth_sessions").get() as { token_hash: string };
    const sessionTimes = context.db.$client.prepare("SELECT created_at, expires_at FROM auth_sessions").get() as {
      created_at: string;
      expires_at: string;
    };
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(sessionTimes.expires_at) - Date.parse(sessionTimes.created_at)).toBe(2_592_000_000);

    await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookiePair(setCookie)).expect(200);
    await context.unauthenticatedApi
      .post("/api/v1/auth/sign-out")
      .set("Cookie", cookiePair(setCookie))
      .expect(204);
    await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookiePair(setCookie)).expect(401);
  });

  it("rejects expired sessions", async () => {
    const context = await setup();
    const message = await issueCode(context);
    const response = await verify(context, message.to, message.code).expect(200);
    const setCookie = setCookieHeader(response);
    context.db.$client.prepare("UPDATE auth_sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookiePair(setCookie)).expect(401);
  });

  it("rejects unauthenticated reads and writes on every protected API surface, including SSE", async () => {
    const context = await setup();
    const unauthorized = context.unauthenticatedApi;
    const calls = [
      unauthorized.get("/api/v1/collections"),
      unauthorized.post("/api/v1/collections").send({ name: "Nope" }),
      unauthorized.get("/api/v1/collections/missing"),
      unauthorized.put("/api/v1/collections/missing").send({ name: "Nope" }),
      unauthorized.delete("/api/v1/collections/missing"),
      unauthorized.get("/api/v1/collections/missing/items/missing"),
      unauthorized.post("/api/v1/collections/missing/items").send({ type: "folder", name: "Nope" }),
      unauthorized.put("/api/v1/collections/missing/items/missing").send({ type: "folder", name: "Nope" }),
      unauthorized.delete("/api/v1/collections/missing/items/missing"),
      unauthorized.get("/api/v1/environments"),
      unauthorized.post("/api/v1/environments").send({ name: "Nope" }),
      unauthorized.get("/api/v1/environments/missing"),
      unauthorized.put("/api/v1/environments/missing").send({ name: "Nope" }),
      unauthorized.delete("/api/v1/environments/missing"),
      unauthorized.get("/api/v1/trash"),
      unauthorized.post("/api/v1/trash/missing/restore/check"),
      unauthorized.post("/api/v1/trash/missing/restore"),
    ];
    for (const call of calls) await call.expect(401);

    const server = await startServer(context.app);
    try {
      const stream = await connectSse(server.url);
      expect(stream.response.statusCode).toBe(401);
      await stream.ended;
    } finally {
      await server.close();
    }
  });

  it("authenticates EventSource-style requests with the session cookie", async () => {
    const context = await setup();
    const message = await issueCode(context);
    const login = await verify(context, message.to, message.code).expect(200);
    const server = await startServer(context.app);
    const stream = await connectSse(server.url, { Cookie: cookiePair(setCookieHeader(login)) });
    try {
      expect(stream.response.statusCode).toBe(200);
      await stream.waitFor((frames) => frames.some((frame) => frame.event === "ready"));
    } finally {
      stream.close();
      await server.close();
    }
  });

  it("makes the cookie Secure attribute configurable", async () => {
    const context = await setup({ env: { AUTH_COOKIE_SECURE: true } });
    const message = await issueCode(context);
    const response = await verify(context, message.to, message.code).expect(200);
    expect(setCookieHeader(response)).toContain("Secure");
  });

  it("records creator and updater attribution on collection, nested item, and environment writes", async () => {
    const context = await setup();
    const creatorMessage = await issueCode(context, "creator@fluttersea.com");
    const creatorLogin = await verify(context, creatorMessage.to, creatorMessage.code).expect(200);
    const creatorCookie = cookiePair(setCookieHeader(creatorLogin));
    const updaterMessage = await issueCode(context, "updater@sisal.it");
    const updaterLogin = await verify(context, updaterMessage.to, updaterMessage.code).expect(200);
    const updaterCookie = cookiePair(setCookieHeader(updaterLogin));
    const client = context.unauthenticatedApi;
    const collection = await client
      .post("/api/v1/collections")
      .set("Cookie", creatorCookie)
      .send({ name: "Attributed", items: [{ type: "folder", name: "Folder" }] })
      .expect(201);
    expect(collection.body).toMatchObject({ createdBy: creatorMessage.to, updatedBy: creatorMessage.to });
    expect(collection.body.items[0]).toMatchObject({ createdBy: creatorMessage.to, updatedBy: creatorMessage.to });
    const savedCollection = await client
      .put(`/api/v1/collections/${collection.body.id}`)
      .set("Cookie", updaterCookie)
      .send({ name: "Renamed", description: "" })
      .expect(200);
    expect(savedCollection.body).toMatchObject({ createdBy: creatorMessage.to, updatedBy: updaterMessage.to });

    const folder = collection.body.items[0];
    const item = await client
      .put(`/api/v1/collections/${collection.body.id}/items/${folder.id}`)
      .set("Cookie", updaterCookie)
      .send({ type: "folder", name: "Folder 2", description: "" })
      .expect(200);
    expect(item.body).toMatchObject({ createdBy: creatorMessage.to, updatedBy: updaterMessage.to });

    const environment = await client
      .post("/api/v1/environments")
      .set("Cookie", creatorCookie)
      .send({ name: "Env", variables: [{ key: "baseUrl", value: "https://api.test" }] })
      .expect(201);
    expect(environment.body).toMatchObject({ createdBy: creatorMessage.to, updatedBy: creatorMessage.to });
    const savedEnvironment = await client
      .put(`/api/v1/environments/${environment.body.id}`)
      .set("Cookie", updaterCookie)
      .send({ name: "Env 2", variables: [{ key: "baseUrl", value: "https://other.test" }] })
      .expect(200);
    expect(savedEnvironment.body).toMatchObject({ createdBy: creatorMessage.to, updatedBy: updaterMessage.to });
  });

  it("keeps pre-auth resource attribution explicitly unknown", async () => {
    const context = await setup();
    const message = await issueCode(context);
    const login = await verify(context, message.to, message.code).expect(200);
    const timestamp = new Date().toISOString();
    context.db.$client
      .prepare(
        "INSERT INTO collections (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("00000000-0000-4000-8000-000000000001", "Legacy", "legacy", "", timestamp, timestamp);
    const collection = await context.unauthenticatedApi
      .get("/api/v1/collections/00000000-0000-4000-8000-000000000001")
      .set("Cookie", cookiePair(setCookieHeader(login)))
      .expect(200);
    expect(collection.body).toMatchObject({ createdBy: null, updatedBy: null });
  });

  it("allows credentialed Vite-origin requests", async () => {
    const context = await setup({ corsOrigin: "http://localhost:5173" });
    const response = await context.unauthenticatedApi
      .options("/api/v1/events")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "GET")
      .expect(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-headers"]).toContain("X-Dev-Inbox-Token");
  });

  it("exposes the in-memory code only through the opted-in loopback development helper", async () => {
    const token = "local-dev-inbox-secret-token-that-is-long";
    const context = await setup({ env: { NODE_ENV: "development", AUTH_DEV_INBOX_TOKEN: token } });
    const message = await issueCode(context);
    await context.unauthenticatedApi
      .get(`/api/v1/auth/dev-inbox?email=${encodeURIComponent(message.to)}`)
      .set("X-Dev-Inbox-Token", "wrong-token")
      .expect(404);
    const inbox = await context.unauthenticatedApi
      .get(`/api/v1/auth/dev-inbox?email=${encodeURIComponent(message.to)}`)
      .set("X-Dev-Inbox-Token", token)
      .expect(200);
    expect(inbox.body.code).toBe(message.code);
  });

  // A misconfigured SMTP host is otherwise a 503 with the reason discarded, which leaves an
  // operator setting up mail with nothing to go on. The caller is still told only that delivery
  // failed, because naming the reason would confirm the address is eligible.
  it("records why a sign-in code could not be delivered without telling the caller", async () => {
    const logged: unknown[] = [];
    const failing = new MemoryEmailCodeSender();
    failing.sendCode = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:587");
    };
    const context = await setup({ emailSender: failing, logger: (err) => logged.push(err) });

    const response = await context.unauthenticatedApi
      .post("/api/v1/auth/request-code")
      .send({ email: "person@sisal.com" })
      .expect(503);

    expect(response.body.error.code).toBe("AUTH_DELIVERY_FAILED");
    expect(response.body.error.message).not.toContain("ECONNREFUSED");
    expect(String(logged[0])).toContain("ECONNREFUSED");
  });

  // A reverse proxy on the same machine makes every caller look local, which would turn the
  // loopback restriction into no restriction at all and hand sign-in codes to anyone holding the
  // token. Verified against a real nginx: without this, a request from another host reached the
  // route through the proxy and got the code, while the same request sent directly got 404.
  it.each(["x-forwarded-for", "x-real-ip", "forwarded"])(
    "refuses the development inbox to a request relayed through a proxy (%s)",
    async (header) => {
      const token = "local-dev-inbox-secret-token-that-is-long";
      const context = await setup({ env: { NODE_ENV: "development", AUTH_DEV_INBOX_TOKEN: token } });
      const message = await issueCode(context);
      await context.unauthenticatedApi
        .get(`/api/v1/auth/dev-inbox?email=${encodeURIComponent(message.to)}`)
        .set("X-Dev-Inbox-Token", token)
        .set(header, header === "forwarded" ? "for=203.0.113.9" : "203.0.113.9")
        .expect(404);
    },
  );
});
