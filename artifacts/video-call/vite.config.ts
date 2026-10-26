import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Sensible defaults so the app also runs outside Replit (where PORT and
// BASE_PATH are injected). Never throw here: a hard throw made `pnpm build`
// and the documented Render deploy fail.
const port = Number(process.env.UI_PORT ?? process.env.PORT ?? 5173);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid UI_PORT/PORT value: "${process.env.UI_PORT ?? process.env.PORT}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

// Where the API server listens during local development.
const apiTarget = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 8080}`;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({ root: path.resolve(import.meta.dirname, "..") }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) => m.devBanner()),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    // Without this, `pnpm dev` could not reach the API server off-Replit.
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/socket.io": { target: apiTarget, ws: true, changeOrigin: true },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
