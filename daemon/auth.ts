/**
 * daemon/auth.ts — Optional API token authentication middleware.
 *
 * When a token is configured (via config.json `apiToken` field or MPT_API_TOKEN env),
 * all API endpoints require a Bearer token in the Authorization header.
 * The /health endpoint is always public (for monitoring).
 *
 * The web UI uses basic auth (username ignored, password = token) when a token is set.
 *
 * Security policy: the daemon refuses to bind 0.0.0.0 without a token configured,
 * preventing accidental exposure of an unprotected API to the network.
 */

import type { Context, Next } from "hono";

/** Paths that never require authentication */
const PUBLIC_PATHS = ["/health"];

/** Check if a path is public (no auth required) */
function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some(p => path === p || path.startsWith(p + "/"));
}

/**
 * Create a Hono middleware that enforces Bearer token authentication.
 * Returns null if no token is configured (auth disabled).
 */
export function createAuthMiddleware(token: string | null): ((c: Context, next: Next) => Promise<Response | void>) | null {
  if (!token) return null;

  return async (c: Context, next: Next): Promise<Response | void> => {
    const path = new URL(c.req.url).pathname;

    // Public paths skip auth
    if (isPublicPath(path)) {
      await next();
      return;
    }

    // Check for Bearer token
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const parts = authHeader.split(" ");
      if (parts.length === 2) {
        const scheme = parts[0]!.toLowerCase();
        const credential = parts[1]!;

        // Bearer token
        if (scheme === "bearer" && credential === token) {
          await next();
          return;
        }

        // Basic auth (for web UI): username ignored, password = token
        if (scheme === "basic") {
          try {
            const decoded = atob(credential);
            const password = decoded.split(":").slice(1).join(":");
            if (password === token) {
              await next();
              return;
            }
          } catch {
            // Invalid base64 — fall through to 401
          }
        }
      }
    }

    // Check query parameter as fallback (for WebSocket/EventSource)
    const urlToken = new URL(c.req.url).searchParams.get("token");
    if (urlToken === token) {
      await next();
      return;
    }

    return c.json({ error: "Unauthorized", message: "Valid API token required" }, 401);
  };
}

/**
 * Resolve the API token from config and environment.
 * Priority: MPT_API_TOKEN env > config.apiToken
 */
export function resolveToken(configToken?: string): string | null {
  return Deno.env.get("MPT_API_TOKEN") || configToken || null;
}

/**
 * Validate that the hostname/token combination is safe.
 * Refuses to bind 0.0.0.0 (all interfaces) without a token.
 */
export function validateBindSafety(hostname: string, token: string | null): { safe: boolean; reason?: string } {
  // Allow localhost/127.0.0.1 without token
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return { safe: true };
  }

  // 0.0.0.0 or any other hostname requires a token
  if (!token) {
    return {
      safe: false,
      reason: `Refusing to bind ${hostname} without an API token. ` +
        `Set MPT_API_TOKEN env or "apiToken" in config.json, ` +
        `or use hostname 127.0.0.1 for local-only access.`,
    };
  }

  return { safe: true };
}

/**
 * Generate a cryptographically secure random token.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
