/**
 * daemon/static.ts — Serves the React UI static files from ui/dist/.
 *
 * In development, Vite handles UI serving with its proxy.
 * In production (or compiled binary), this middleware serves the built
 * UI files and falls back to index.html for client-side routing.
 *
 * The UI dist path is resolved relative to the entry script, or can be
 * overridden with the UI_DIST environment variable.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
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
  const envDist = process.env["UI_DIST"];
  if (envDist && existsSync(envDist)) return envDist;

  // Try relative to CWD (typical for development)
  const cwdDist = path.join(process.cwd(), "ui", "dist");
  if (existsSync(cwdDist)) return cwdDist;

  // Try relative to the entry script (daemon/main.ts, cli/main.ts or main.ts).
  // A symlinked entry (a global `mpt` bin) is followed back to the package.
  const entry = process.argv[1];
  if (entry) {
    let mainDir = path.dirname(entry);
    try { mainDir = path.dirname(fs.realpathSync(entry)); } catch { /* keep the path as given */ }
    const relDist = path.join(mainDir, "..", "ui", "dist");
    if (existsSync(relDist)) return relDist;

    // The root main.ts sits beside ui/ (also where `deno compile --include` puts it).
    const siblingDist = path.join(mainDir, "ui", "dist");
    if (existsSync(siblingDist)) return siblingDist;
  }

  // Try relative to this module: <root>/daemon/static.ts → <root>/ui/dist.
  const moduleDist = fileURLToPath(new URL("../ui/dist", import.meta.url));
  if (existsSync(moduleDist)) return moduleDist;

  return null;
}

/**
 * Create a Hono middleware that serves static files from the UI dist directory.
 * Falls back to index.html for unmatched routes (SPA client-side routing).
 */
export function staticMiddleware(distDir: string) {
  // deno-lint-ignore require-await -- Hono's middleware handler type expects an async signature
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
