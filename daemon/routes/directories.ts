/**
 * daemon/routes/directories.ts — Directory suggestions for the UI's pickers.
 *
 * `GET /api/directories` returns the favorites (team config
 * `favoriteDirectories`) and the recently used directories; every directory
 * input lists favorites first, then recent. `/api/directories/favorites`
 * adds, replaces, or removes favorites. Paths are normalized by the Store
 * (`normalizeDirectory`: `~` expanded, symlinks resolved), matching how
 * stored directories are compared for affinity. See docs/DESIGN.md
 * "Favorite Directories".
 */

import type { RouteContext } from "./types.ts";
import type {
  AddFavoriteDirectoryRequest, DirectoriesResponse, FavoriteDirectoriesResponse, SetFavoriteDirectoriesRequest,
} from "../../shared/protocol.ts";

/** Is `v` a non-empty string after trimming? */
function isPath(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function registerDirectoryRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/directories", (c) => {
    return c.json({
      favorites: store.getFavoriteDirectories(),
      recent: store.getRecentDirectories(),
    } satisfies DirectoriesResponse);
  });

  app.post("/api/directories/favorites", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Partial<AddFavoriteDirectoryRequest>;
    if (!isPath(body.directory)) {
      return c.json({ success: false, error: "Field 'directory' must be a non-empty string" } satisfies FavoriteDirectoriesResponse, 400);
    }
    return c.json({ success: true, favorites: store.addFavoriteDirectory(body.directory) } satisfies FavoriteDirectoriesResponse);
  });

  app.put("/api/directories/favorites", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Partial<SetFavoriteDirectoriesRequest>;
    if (!Array.isArray(body.directories) || !body.directories.every(isPath)) {
      return c.json({ success: false, error: "Field 'directories' must be an array of non-empty strings" } satisfies FavoriteDirectoriesResponse, 400);
    }
    return c.json({ success: true, favorites: store.setFavoriteDirectories(body.directories) } satisfies FavoriteDirectoriesResponse);
  });

  // The path goes in a query parameter (`?directory=`), not the URL path, so
  // slashes need no special encoding.
  app.delete("/api/directories/favorites", (c) => {
    const directory = c.req.query("directory");
    if (!isPath(directory)) {
      return c.json({ success: false, error: "Query parameter 'directory' is required" } satisfies FavoriteDirectoriesResponse, 400);
    }
    if (!store.removeFavoriteDirectory(directory)) {
      return c.json({ success: false, error: "Not a favorite directory" } satisfies FavoriteDirectoriesResponse, 404);
    }
    return c.json({ success: true, favorites: store.getFavoriteDirectories() } satisfies FavoriteDirectoriesResponse);
  });
}
