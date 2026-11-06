import { resolve } from "node:path";
import { createServer } from "vite";

process.env.VITE_API_URL = "http://127.0.0.1:3310/api";

const server = await createServer({
  configFile: resolve(process.cwd(), "vite.config.js"),
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});

await server.listen();
server.printUrls();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
