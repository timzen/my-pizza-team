// Board HTML template for the kanban web UI
//
// Reads board.html at module load time. The HTML file is a self-contained
// vanilla HTML/JS single-page app that polls the JSON API every 3 seconds.
import * as fs from "node:fs";
import * as path from "node:path";

// Resolve board.html relative to this module's location
const boardHtmlPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "board.html"
);

const BOARD_HTML = fs.readFileSync(boardHtmlPath, "utf-8");

export { BOARD_HTML };
