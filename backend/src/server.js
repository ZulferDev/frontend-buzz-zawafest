import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createStateStore } from "./database.js";

const port = Number(process.env.PORT ?? 3000);
const frontendPort = Number(process.env.FRONTEND_PORT ?? 5173);
const databasePath = process.env.SQLITE_PATH ?? "./data/zawa.sqlite";
const allowedOrigins = (process.env.FRONTEND_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT harus berupa bilangan bulat antara 1 dan 65535.");
}
if (!Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65535) {
  throw new Error("FRONTEND_PORT harus berupa bilangan bulat antara 1 dan 65535.");
}

const store = createStateStore(databasePath);
const app = createApp({ store, allowedOrigins, frontendPort });
const host = process.env.HOST ?? "0.0.0.0";
const server = serve({ fetch: app.fetch, port, hostname: host });

console.log(`ZAWA backend listening on http://${host}:${port}`);
console.log(`SQLite database: ${databasePath}`);

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error("[server] Gagal menutup server:", error);
      process.exitCode = 1;
    }
    store.close();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
