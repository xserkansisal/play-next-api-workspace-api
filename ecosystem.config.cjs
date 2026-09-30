const { homedir } = require("node:os");
const { join } = require("node:path");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set before starting play-next-api with PM2`);
  }
  return value;
}

const logDirectory = process.env.PM2_LOG_DIR || join(homedir(), ".pm2", "logs");

module.exports = {
  apps: [
    {
      name: "play-next-api",
      cwd: __dirname,
      script: "./dist/server.js",
      // The SSE hub and SQLite writer are process-local; do not use cluster mode or scale out.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      time: true,
      out_file: join(logDirectory, "play-next-api-out.log"),
      error_file: join(logDirectory, "play-next-api-error.log"),
      env: {
        NODE_ENV: "production",
        HOST: process.env.HOST || "127.0.0.1",
        PORT: required("PORT"),
        DATABASE_PATH: required("DATABASE_PATH"),
        SSE_HEARTBEAT_MS: process.env.SSE_HEARTBEAT_MS || "15000",
        SSE_RETRY_MS: process.env.SSE_RETRY_MS || "3000",
        AUTH_CODE_PEPPER: required("AUTH_CODE_PEPPER"),
        AUTH_CODE_TTL_SECONDS: process.env.AUTH_CODE_TTL_SECONDS || "900",
        AUTH_CODE_MAX_ATTEMPTS: process.env.AUTH_CODE_MAX_ATTEMPTS || "5",
        AUTH_CODE_REQUEST_LIMIT: process.env.AUTH_CODE_REQUEST_LIMIT || "3",
        AUTH_CODE_REQUEST_WINDOW_SECONDS: process.env.AUTH_CODE_REQUEST_WINDOW_SECONDS || "900",
        AUTH_CODE_VERIFY_LIMIT: process.env.AUTH_CODE_VERIFY_LIMIT || "10",
        AUTH_CODE_VERIFY_WINDOW_SECONDS: process.env.AUTH_CODE_VERIFY_WINDOW_SECONDS || "900",
        AUTH_SESSION_TTL_SECONDS: process.env.AUTH_SESSION_TTL_SECONDS || "2592000",
        AUTH_COOKIE_NAME: process.env.AUTH_COOKIE_NAME || "play_next_session",
        AUTH_COOKIE_SECURE: process.env.AUTH_COOKIE_SECURE || "false",
        ...(process.env.SMTP_HOST ? { SMTP_HOST: process.env.SMTP_HOST } : {}),
        SMTP_PORT: process.env.SMTP_PORT || "587",
        SMTP_SECURE: process.env.SMTP_SECURE || "false",
        ...(process.env.SMTP_USER ? { SMTP_USER: process.env.SMTP_USER } : {}),
        ...(process.env.SMTP_PASSWORD ? { SMTP_PASSWORD: process.env.SMTP_PASSWORD } : {}),
        ...(process.env.SMTP_FROM ? { SMTP_FROM: process.env.SMTP_FROM } : {}),
        ...(process.env.AUTH_DEV_INBOX_TOKEN ? { AUTH_DEV_INBOX_TOKEN: process.env.AUTH_DEV_INBOX_TOKEN } : {}),
        ...(process.env.CORS_ORIGIN ? { CORS_ORIGIN: process.env.CORS_ORIGIN } : {}),
        // Server-side request execution. Without these the API sees no allow-list and refuses
        // every proxied request, so "Send from: Server" silently stops working in production even
        // though the operator exported the hosts. Left absent when unset, so the API keeps its own
        // safe default of having the proxy disabled.
        ...(process.env.PROXY_ALLOWED_HOSTS ? { PROXY_ALLOWED_HOSTS: process.env.PROXY_ALLOWED_HOSTS } : {}),
        PROXY_TIMEOUT_MS: process.env.PROXY_TIMEOUT_MS || "30000",
        PROXY_MAX_RESPONSE_BYTES: process.env.PROXY_MAX_RESPONSE_BYTES || "10485760",
      },
    },
  ],
};
