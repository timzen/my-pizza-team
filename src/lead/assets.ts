// Static asset loader for the web UI
//
// Reads all static assets (HTML, CSS, JS) at module load time and exports
// them as string constants for serving via the HTTP API. This avoids
// filesystem reads on every request.
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);

function loadAsset(filename: string): string {
  return fs.readFileSync(path.join(dir, filename), "utf-8");
}

// HTML pages
export const BOARD_HTML = loadAsset("board.html");
export const ARCHIVED_HTML = loadAsset("archived-page.html");
export const CONFIG_HTML = loadAsset("config-page.html");

// Stylesheets
export const BOARD_CSS = loadAsset("board.css");
export const ARCHIVED_CSS = loadAsset("archived-page.css");
export const CONFIG_CSS = loadAsset("config-page.css");
export const NAV_CSS = loadAsset("nav.css");

// Shared browser JavaScript
export const SHARED_JS = loadAsset("shared.js");
export const NAV_JS = loadAsset("nav.js");
