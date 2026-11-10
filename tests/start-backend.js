import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = resolve(tmpdir(), `zawa-e2e-${process.pid}.sqlite`);
const backendEntry = resolve(frontendRoot, "backend", "src", "server.js");

function removeTestDatabase() {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

removeTestDatabase();

process.env.HOST = "127.0.0.1";
process.env.PORT = "3310";
process.env.SQLITE_PATH = databasePath;
process.env.FRONTEND_ORIGINS = "http://127.0.0.1:5174";

process.once("exit", removeTestDatabase);

await import(backendEntry);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    setTimeout(() => {
      removeTestDatabase();
      process.exit(0);
    }, 1000);
  });
}
