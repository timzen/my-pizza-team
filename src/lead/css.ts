// Static asset loader for the web UI
//
// Reads CSS and JS files at module load time, making them available as
// string constants for serving via the HTTP API.
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);

export const BOARD_CSS = fs.readFileSync(path.join(dir, "board.css"), "utf-8");
export const ARCHIVED_CSS = fs.readFileSync(path.join(dir, "archived-page.css"), "utf-8");
export const SHARED_JS = fs.readFileSync(path.join(dir, "shared.js"), "utf-8");
