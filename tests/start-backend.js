import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = resolve(tmpdir(), `zawa-e2e-${process.pid}.sqlite`);
const backendRoot = resolve(frontendRoot, "backend-go");

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

const backend = spawn("go", ["run", "./cmd/server"], {
  cwd: backendRoot,
  env: process.env,
  stdio: "inherit",
});

backend.once("error", (error) => {
  console.error("[backend] Go server gagal dijalankan:", error);
  process.exitCode = 1;
});
backend.once("exit", (code, signal) => {
  removeTestDatabase();
  if (signal && !process.exitCode) process.exitCode = 1;
  else if (code && !process.exitCode) process.exitCode = code;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => backend.kill(signal));
}
