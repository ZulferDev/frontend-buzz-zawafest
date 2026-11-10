import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const backendRoot = resolve(root, "backend");
const backendPort = process.env.PORT || "3000";
const frontendPort = process.env.FRONTEND_PORT || "5173";
const environment = { ...process.env };
const children = [];
let stopping = false;

function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function start(label, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(`[${label}] Tidak dapat dijalankan:`, error);
    process.exitCode = 1;
    stopChildren();
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    if (code !== 0) {
      console.error(`[${label}] Berhenti (exit=${code}, signal=${signal ?? "none"}).`);
      process.exitCode = code ?? 1;
      stopChildren();
    }
  });
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

start("backend", ["--watch", "src/server.js"], backendRoot, {
  ...environment,
  HOST: "0.0.0.0",
  PORT: backendPort,
  FRONTEND_PORT: frontendPort,
});
start("frontend", [
  resolve(root, "node_modules/vite/bin/vite.js"),
  "--host",
  "0.0.0.0",
  "--port",
  frontendPort,
  "--strictPort",
], root, {
  ...environment,
  VITE_API_PORT: backendPort,
});
