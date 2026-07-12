/**
 * daemon/static.ts — Serves the React UI static files from ui/dist/.
 *
 * In development, Vite handles UI serving with its proxy.
 * In production (or compiled binary), this middleware serves the built
 * UI files and falls back to index.html for client-side routing.
 *
 * The UI dist path is resolved relative to the main module, or can be
 * overridden with the UI_DIST environment variable.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { Context, Next } from "hono";

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

/** Resolve the UI dist directory path */
export function resolveDistDir(): string | null {
  // Check env override first
  const envDist = Deno.env.get("UI_DIST");
  if (envDist && existsSync(envDist)) return envDist;

  // Try relative to CWD (typical for development)
  const cwdDist = path.join(Deno.cwd(), "ui", "dist");
  if (existsSync(cwdDist)) return cwdDist;

  // Try relative to the main module (for compiled binary)
  const mainDir = path.dirname(path.fromFileUrl(Deno.mainModule));
  const relDist = path.join(mainDir, "..", "ui", "dist");
  if (existsSync(relDist)) return relDist;

  // Try embedded path (deno compile --include puts files relative to binary)
  const embeddedDist = path.join(mainDir, "ui", "dist");
  if (existsSync(embeddedDist)) return embeddedDist;

  return null;
}

/**
 * Create a Hono middleware that serves static files from the UI dist directory.
 * Falls back to index.html for unmatched routes (SPA client-side routing).
 */
export function staticMiddleware(distDir: string) {
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
        const stat = Deno.statSync(filePath);
        if (stat.isFile) {
          const content = Deno.readFileSync(filePath);
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
      const content = Deno.readFileSync(indexPath);
      return new Response(content, {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
      });
    }

    return next();
  };
}
