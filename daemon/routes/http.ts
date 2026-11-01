/**
 * daemon/routes/http.ts — The request/response helpers every route module shares.
 *
 * One way to read a JSON body and one way to write an error reply, so routes
 * can't drift apart (docs/ARCHITECTURE.md "Request parsing and error replies"):
 *   - `readBody(c)` — an empty body is `{}`; malformed JSON stops the request
 *     with a 400 `{ success: false, error: "Invalid JSON body" }` (thrown as an
 *     `HTTPException`, which `app.onError` in daemon/server.ts turns into its
 *     response).
 *   - `fail(c, status, error, extra?)` — the `{ success: false, error, ...extra }`
 *     reply.
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The error a malformed JSON body gets (always a 400). */
export const INVALID_JSON_ERROR = "Invalid JSON body";

/**
 * Parse the request's JSON body. An empty (or whitespace-only) body is `{}`, so
 * a route's own field checks report what's missing; malformed JSON throws an
 * `HTTPException` carrying the 400 reply. The caller asserts the shape (`T`)
 * and still validates the fields it reads.
 */
export async function readBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  // text() rather than json(): only the raw text tells empty from malformed.
  // Hono caches it, so a middleware that read the body first (features.ts) is fine.
  const text = await c.req.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, {
      res: Response.json({ success: false, error: INVALID_JSON_ERROR }, { status: 400 }),
    });
  }
}

/**
 * The error reply: `{ success: false, error, ...extra }` with `status`. `extra`
 * carries a route's additional fields (`fieldErrors`, `usedBy`, `updated`, …).
 * `error` may be undefined for a Store result typed `{ ok; error?: string }`;
 * the key is then left out, exactly as `c.json` always did.
 */
export function fail(c: Context, status: ContentfulStatusCode, error: string | undefined, extra?: Record<string, unknown>): Response {
  return c.json({ success: false, error, ...extra }, status);
}
