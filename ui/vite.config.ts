import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 1024,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The daemon's wire types (docs/ARCHITECTURE.md "Shared Types"): `import type`
      // from here; the few runtime values the UI shares are pure modules.
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    // ../shared sits outside the UI package, so let the dev server serve it too.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(__dirname, "../shared")] },
    proxy: {
      "/api": {
        target: "http://localhost:7437",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:7437",
        changeOrigin: true,
      },
    },
  },
});
