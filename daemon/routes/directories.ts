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
import { readBody, fail } from "./http.ts";
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
    const body = await readBody(c) as Partial<AddFavoriteDirectoryRequest>;
    if (!isPath(body.directory)) {
      return fail(c, 400, "Field 'directory' must be a non-empty string");
    }
    return c.json({ success: true, favorites: store.addFavoriteDirectory(body.directory) } satisfies FavoriteDirectoriesResponse);
  });

  app.put("/api/directories/favorites", async (c) => {
    const body = await readBody(c) as Partial<SetFavoriteDirectoriesRequest>;
    if (!Array.isArray(body.directories) || !body.directories.every(isPath)) {
      return fail(c, 400, "Field 'directories' must be an array of non-empty strings");
    }
    return c.json({ success: true, favorites: store.setFavoriteDirectories(body.directories) } satisfies FavoriteDirectoriesResponse);
  });

  // The path goes in a query parameter (`?directory=`), not the URL path, so
  // slashes need no special encoding.
  app.delete("/api/directories/favorites", (c) => {
    const directory = c.req.query("directory");
    if (!isPath(directory)) {
      return fail(c, 400, "Query parameter 'directory' is required");
    }
    if (!store.removeFavoriteDirectory(directory)) {
      return fail(c, 404, "Not a favorite directory");
    }
    return c.json({ success: true, favorites: store.getFavoriteDirectories() } satisfies FavoriteDirectoriesResponse);
  });
}
