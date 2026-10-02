import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSse, startServer } from "../sse.js";
import { createTestContext, dropTestDatabase, queryRows, type TestContext } from "../helpers.js";
import { MemoryEmailCodeSender } from "../../src/auth/email.js";
import sharp from "sharp";

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
    const row = (await queryRows(context.db, "SELECT code_hash, expires_at FROM auth_codes WHERE email = ?", ["hash@sisal.com"]))[0]!;
    const codeColumns = await queryRows(context.db, "SHOW COLUMNS FROM auth_codes");
    const issuedAt = (await queryRows(context.db, "SELECT created_at FROM auth_codes WHERE email = ?", ["hash@sisal.com"]))[0]!;
    expect(row.code_hash).not.toContain(message.code);
    expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(codeColumns.map(({ Field }) => Field)).toContain("code_hash");
    expect(codeColumns.map(({ Field }) => Field)).not.toContain("code");
    expect(Date.parse(row.expires_at) - Date.parse(message.expiresAt)).toBe(0);
    expect(Date.parse(row.expires_at) - Date.parse(issuedAt.created_at)).toBe(900_000);
  });

  it("rejects expired and already-used codes", async () => {
    const context = await setup();
    const expired = await issueCode(context, "expired@sisal.com");
    await context.db.$client.query("UPDATE auth_codes SET expires_at = ? WHERE email = ?", [
      new Date(Date.now() - 1000).toISOString(),
      expired.to,
    ]);
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
    expect(response.body.user).toMatchObject({
      email: message.to,
      firstName: "Person",
      lastName: "",
    });
    expect(Date.parse(response.body.expiresAt) - Date.now()).toBeGreaterThan(2_591_000_000);
    expect(Date.parse(response.body.expiresAt) - Date.now()).toBeLessThanOrEqual(2_592_000_000);
    const setCookie = setCookieHeader(response);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    const token = cookieValue(setCookie);
    const stored = (await queryRows(context.db, "SELECT token_hash FROM auth_sessions"))[0]!;
    const sessionTimes = (await queryRows(context.db, "SELECT created_at, expires_at FROM auth_sessions"))[0]!;
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(sessionTimes.expires_at) - Date.parse(sessionTimes.created_at)).toBe(2_592_000_000);

    const me = await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookiePair(setCookie)).expect(200);
    expect(me.body.user).toEqual(response.body.user);
    await context.unauthenticatedApi
      .post("/api/v1/auth/sign-out")
      .set("Cookie", cookiePair(setCookie))
      .expect(204);
    await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookiePair(setCookie)).expect(401);
  });

  it("persists derived profile names and preserves existing names across later sign-ins", async () => {
    const context = await setup();
    const email = "serkan.taghan@sisal.com";
    const firstMessage = await issueCode(context, email);
    const firstLogin = await verify(context, email, firstMessage.code).expect(200);
    expect(firstLogin.body.user).toMatchObject({ email, firstName: "Serkan", lastName: "Taghan" });

    await context.db.$client.query("UPDATE users SET first_name = ?, last_name = ? WHERE email = ?", [
      "Saved",
      "Profile",
      email,
    ]);
    const secondMessage = await issueCode(context, email);
    const secondLogin = await verify(context, email, secondMessage.code).expect(200);
    expect(secondLogin.body.user).toMatchObject({ email, firstName: "Saved", lastName: "Profile" });

    const me = await context.unauthenticatedApi
      .get("/api/v1/auth/me")
      .set("Cookie", cookiePair(setCookieHeader(secondLogin)))
      .expect(200);
    expect(me.body.user).toMatchObject({ firstName: "Saved", lastName: "Profile" });
  });

  it("does not accept client-supplied profile names during verification", async () => {
    const context = await setup();
    const email = "client.names@sisal.com";
    const message = await issueCode(context, email);
    await context.unauthenticatedApi
      .post("/api/v1/auth/verify-code")
      .send({ email, code: message.code, firstName: "Attacker", lastName: "Controlled" })
      .expect(400);
    const login = await verify(context, email, message.code).expect(200);
    expect(login.body.user).toMatchObject({ firstName: "Client", lastName: "Names" });
  });

  it("updates only the signed-in user's avatar colour", async () => {
    const context = await setup();
    const message = await issueCode(context, "avatar.user@sisal.com");
    const login = await verify(context, message.to, message.code).expect(200);
    expect(login.body.user.avatarColor).toBe("violet");
    const cookie = cookiePair(setCookieHeader(login));

    const updated = await context.unauthenticatedApi
      .patch("/api/v1/auth/me/profile")
      .set("Cookie", cookie)
      .send({ avatarColor: "teal" })
      .expect(200);
    expect(updated.body.user).toEqual({ ...login.body.user, avatarColor: "teal" });

    const me = await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookie).expect(200);
    expect(me.body.user.avatarColor).toBe("teal");

    for (const body of [{ avatarColor: "black" }, { avatarColor: "blue", firstName: "Changed" }, { email: "x@sisal.com" }, {}]) {
      const rejected = await context.unauthenticatedApi
        .patch("/api/v1/auth/me/profile")
        .set("Cookie", cookie)
        .send(body)
        .expect(400);
      expect(rejected.body.error.code).toBe("VALIDATION_ERROR");
    }
    const unchanged = await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookie).expect(200);
    expect(unchanged.body.user).toEqual({ ...login.body.user, avatarColor: "teal" });

    await context.unauthenticatedApi.patch("/api/v1/auth/me/profile").send({ avatarColor: "blue" }).expect(401);
  });

  describe("profile photo", () => {
    async function signedIn(context: TestContext, email = "photo.user@sisal.com") {
      const message = await issueCode(context, email);
      const login = await verify(context, message.to, message.code).expect(200);
      return { cookie: cookiePair(setCookieHeader(login)), user: login.body.user };
    }

    function image(format: "jpeg" | "png" | "webp", width = 64, height = 32) {
      return sharp({ create: { width, height, channels: 3, background: "#3366cc" } })
        .withMetadata({ exif: { IFD0: { Copyright: "secret-metadata" } } })
        [format]()
        .toBuffer();
    }

    function upload(context: TestContext, cookie: string, file: Buffer, filename = "photo.png", contentType = "image/png") {
      return context.unauthenticatedApi
        .post("/api/v1/auth/me/avatar")
        .set("Cookie", cookie)
        .attach("avatar", file, { filename, contentType });
    }

    it("stores JPEG, PNG and WebP uploads as metadata-free WebP and returns avatarUrl", async () => {
      const context = await setup();
      const { cookie, user } = await signedIn(context);
      expect(user.avatarUrl).toBeNull();

      const urls: string[] = [];
      for (const format of ["jpeg", "png", "webp"] as const) {
        // The declared type is deliberately wrong: the server must go by the file's bytes.
        const response = await upload(context, cookie, await image(format), "x.txt", "text/plain").expect(200);
        expect(response.body.user).toEqual({ ...user, avatarUrl: expect.stringMatching(/^\/api\/v1\/auth\/avatars\/[0-9a-f-]{36}$/) });
        urls.push(response.body.user.avatarUrl);
      }
      expect(new Set(urls).size).toBe(3);
      expect((await queryRows(context.db, "SELECT COUNT(*) AS count FROM user_avatars"))[0]!.count).toBe(1);

      await context.unauthenticatedApi.get(urls[0]!).set("Cookie", cookie).expect(404);
      const served = await context.unauthenticatedApi
        .get(urls[2]!)
        .set("Cookie", cookie)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(served.headers["content-type"]).toBe("image/webp");
      expect(served.headers["cache-control"]).toContain("immutable");
      const metadata = await sharp(served.body as Buffer).metadata();
      expect(metadata).toMatchObject({ format: "webp", width: 512, height: 512 });
      expect(metadata.exif).toBeUndefined();
      expect((served.body as Buffer).includes("secret-metadata")).toBe(false);

      await context.unauthenticatedApi.get(urls[2]!).expect(401);
      const me = await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookie).expect(200);
      expect(me.body.user.avatarUrl).toBe(urls[2]);
    });

    it("removes the stored photo and falls back to the saved colour", async () => {
      const context = await setup();
      const { cookie, user } = await signedIn(context);
      const uploaded = await upload(context, cookie, await image("png")).expect(200);
      const removed = await context.unauthenticatedApi.delete("/api/v1/auth/me/avatar").set("Cookie", cookie).expect(200);
      expect(removed.body.user).toEqual({ ...user, avatarUrl: null });
      expect((await queryRows(context.db, "SELECT COUNT(*) AS count FROM user_avatars"))[0]!.count).toBe(0);
      await context.unauthenticatedApi.get(uploaded.body.user.avatarUrl).set("Cookie", cookie).expect(404);
      await context.unauthenticatedApi.delete("/api/v1/auth/me/avatar").set("Cookie", cookie).expect(200);
    });

    it("rejects unsupported, corrupt, oversized and malformed uploads", async () => {
      const context = await setup();
      const { cookie } = await signedIn(context);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      expect((await upload(context, cookie, svg, "a.png", "image/png").expect(415)).body.error.code).toBe("AVATAR_UNSUPPORTED_TYPE");
      const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).gif().toBuffer();
      expect((await upload(context, cookie, gif).expect(415)).body.error.code).toBe("AVATAR_UNSUPPORTED_TYPE");

      const png = await image("png");
      const corrupt = Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 7)]);
      expect((await upload(context, cookie, corrupt).expect(400)).body.error.code).toBe("AVATAR_INVALID_IMAGE");

      const oversized = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
      expect((await upload(context, cookie, oversized).expect(413)).body.error.code).toBe("AVATAR_TOO_LARGE");

      const wrongField = await context.unauthenticatedApi
        .post("/api/v1/auth/me/avatar")
        .set("Cookie", cookie)
        .attach("photo", png, "a.png")
        .expect(400);
      expect(wrongField.body.error.code).toBe("AVATAR_UPLOAD_INVALID");
      await context.unauthenticatedApi.post("/api/v1/auth/me/avatar").set("Cookie", cookie).send({}).expect(400);
      expect((await queryRows(context.db, "SELECT COUNT(*) AS count FROM user_avatars"))[0]!.count).toBe(0);
    });

    it("requires a session for upload and removal", async () => {
      const context = await setup();
      await context.unauthenticatedApi.post("/api/v1/auth/me/avatar").attach("avatar", await image("png"), "a.png").expect(401);
      await context.unauthenticatedApi.delete("/api/v1/auth/me/avatar").expect(401);
    });

    it("returns an absolute URL to browsers on the allowed cross-origin client", async () => {
      const context = await setup({ env: { CORS_ORIGIN: "http://localhost:5173" } });
      const { cookie } = await signedIn(context);
      const response = await upload(context, cookie, await image("png")).set("Origin", "http://localhost:5173").expect(200);
      expect(response.body.user.avatarUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/auth\/avatars\//);
    });
  });

  it("allows PATCH in CORS preflight responses", async () => {
    const context = await setup({ env: { CORS_ORIGIN: "http://localhost:5173" } });
    const preflight = await context.unauthenticatedApi
      .options("/api/v1/auth/me/profile")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "PATCH")
      .expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
  });

  it("rejects expired sessions", async () => {
    const context = await setup();
    const message = await issueCode(context);
    const response = await verify(context, message.to, message.code).expect(200);
    const setCookie = setCookieHeader(response);
    await context.db.$client.query("UPDATE auth_sessions SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]);
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
    await context.db.$client.query(
      "INSERT INTO collections (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["00000000-0000-4000-8000-000000000001", "Legacy", "legacy", "", timestamp, timestamp],
    );
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

  it("does not register the code-free dev login unless the bypass is on", async () => {
    const context = await setup({ env: { NODE_ENV: "development" } });
    await context.unauthenticatedApi.post("/api/v1/auth/dev-login").send({ email: "dev@sisal.com" }).expect(404);
  });

  it("signs in with an email alone when the development bypass is on", async () => {
    const context = await setup({ env: { NODE_ENV: "development", AUTH_DEV_BYPASS: true } });
    const response = await context.unauthenticatedApi.post("/api/v1/auth/dev-login").send({ email: "Dev.Person@sisal.com" }).expect(200);
    expect(response.body.user.email).toBe("dev.person@sisal.com");
    const cookie = cookiePair(setCookieHeader(response));
    expect(cookie.startsWith("play_next_session_dev=")).toBe(true);
    const me = await context.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", cookie).expect(200);
    expect(me.body.user.email).toBe("dev.person@sisal.com");
    const again = await context.unauthenticatedApi.post("/api/v1/auth/dev-login").send({ email: "dev.person@sisal.com" }).expect(200);
    expect(again.body.user.id).toBe(response.body.user.id);
  });

  it("keeps the domain allow-list on the development bypass", async () => {
    const context = await setup({ env: { NODE_ENV: "development", AUTH_DEV_BYPASS: true } });
    const response = await context.unauthenticatedApi.post("/api/v1/auth/dev-login").send({ email: "dev@example.com" }).expect(400);
    expect(response.body.error.code).toBe("EMAIL_DOMAIN_NOT_ALLOWED");
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

  // Rotating AUTH_CODE_PEPPER is the recommended response to a suspected leak, so what it costs
  // has to be known rather than assumed. Measured here: sessions survive (they are hashed without
  // the pepper), only codes already in flight are invalidated, and those users request another.
  it("keeps sessions signed in when the code pepper is rotated, and only invalidates codes in flight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pepper-rotation-"));
    const databasePath = join(directory, "rotation");
    const before = await createTestContext(databasePath, {
      authenticate: false,
      env: { AUTH_CODE_PEPPER: "a-pepper-used-before-the-rotation-000000" },
    });

    let sessionCookie: string;
    let codeInFlight: string;
    try {
      const signIn = await issueCode(before, "stays@sisal.com");
      const session = await before.unauthenticatedApi
        .post("/api/v1/auth/verify-code")
        .send({ email: signIn.to, code: signIn.code })
        .expect(200);
      sessionCookie = session.headers["set-cookie"]![0]!.split(";", 1)[0]!;

      const pending = await issueCode(before, "midflight@sisal.com");
      codeInFlight = pending.code;
    } finally {
      await before.close();
    }

    ctx = await createTestContext(databasePath, {
      authenticate: false,
      env: { AUTH_CODE_PEPPER: "a-different-pepper-after-the-rotation-111" },
    });

    await ctx.unauthenticatedApi.get("/api/v1/auth/me").set("Cookie", sessionCookie).expect(200);

    await ctx.unauthenticatedApi
      .post("/api/v1/auth/verify-code")
      .send({ email: "midflight@sisal.com", code: codeInFlight })
      .expect(401);

    const reissued = await issueCode(ctx, "midflight@sisal.com");
    await ctx.unauthenticatedApi
      .post("/api/v1/auth/verify-code")
      .send({ email: reissued.to, code: reissued.code })
      .expect(200);

    await dropTestDatabase(databasePath);
    rmSync(directory, { recursive: true, force: true });
  });
});
