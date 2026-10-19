/**
 * daemon/static.ts — Serves the React UI static files from ui/dist/.
 *
 * In development, Vite handles UI serving with its proxy.
 * In production (the npm package), this middleware serves the built
 * UI files and falls back to index.html for client-side routing.
 *
 * The UI dist path is the package's `ui/dist` (shared/paths.ts), or can be
 * overridden with the UI_DIST environment variable.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import type { Context, Next } from "hono";
import { uiDistDir } from "../shared/paths.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/**
 * Resolve the UI dist directory: `UI_DIST` if set, else the package's own
 * `ui/dist` (shared/paths.ts — the checkout from source, the installed package
 * otherwise), else `<cwd>/ui/dist` as a last resort. The package's own copy wins
 * over the cwd so an installed mpt started inside some other checkout serves the
 * UI that matches its own daemon.
 */
export function resolveDistDir(): string | null {
  const envDist = process.env["UI_DIST"];
  if (envDist && existsSync(envDist)) return envDist;

  const own = uiDistDir();
  if (existsSync(own)) return own;

  const cwdDist = path.join(process.cwd(), "ui", "dist");
  if (existsSync(cwdDist)) return cwdDist;

  return null;
}

/**
 * Create a Hono middleware that serves static files from the UI dist directory.
 * Falls back to index.html for unmatched routes (SPA client-side routing).
 */
export function staticMiddleware(distDir: string) {
  // async with no await: Hono's middleware handler type expects an async signature
  return async (c: Context, next: Next) => {
    const reqPath = new URL(c.req.url).pathname;

    // Skip API routes — let them pass through to API handlers
    if (reqPath.startsWith("/api/") || reqPath === "/health") {
      return next();
    }

    // Try to serve the exact file
    const filePath = path.join(distDir, reqPath);
    if (existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          return new Response(content, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": reqPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            },
          });
        }
      } catch {
        // Fall through to index.html
      }
    }

    // SPA fallback: serve index.html for all non-file routes
    const indexPath = path.join(distDir, "index.html");
    if (existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      return new Response(content, {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
      });
    }

    return next();
  };
}
