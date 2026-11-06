import { defineConfig } from "vite";

function phpRouteFallback() {
  const rewrite = (req, _res, next) => {
    if (/^\/(?:admin|quiz|player)\.php(?:\?|$)/.test(req.url ?? "")) {
      req.url = "/index.html";
    }
    next();
  };

  return {
    name: "local-php-route-fallback",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [phpRouteFallback()],
});
