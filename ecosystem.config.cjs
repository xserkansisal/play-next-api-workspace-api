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
        ...(process.env.CORS_ORIGIN ? { CORS_ORIGIN: process.env.CORS_ORIGIN } : {}),
      },
    },
  ],
};
