// Archived page HTML template
//
// Loads archived-page.html at module load time.
import * as fs from "node:fs";
import * as path from "node:path";

const archivedHtmlPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "archived-page.html"
);

const ARCHIVED_HTML = fs.readFileSync(archivedHtmlPath, "utf-8");

export { ARCHIVED_HTML };
