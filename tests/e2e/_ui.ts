/**
 * tests/e2e/_ui.ts — what the browser-driven e2e tests share: whether
 * Playwright's Chromium is installed (they skip, rather than fail, on a machine
 * without it), and building the UI they load when ui/dist is stale.
 *
 * A real daemon serves ui/dist (daemon/static.ts), so a test that loads the UI
 * must make sure that build matches the sources it's meant to check.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_INDEX = path.join(REPO, "ui", "dist", "index.html");

/** Is Playwright's Chromium installed (~/.cache/ms-playwright)? */
export function hasChromium(): boolean {
  try { return fs.existsSync(chromium.executablePath()); } catch { return false; }
}

/** The newest mtime under `dir` (ms). */
function newest(dir: string): number {
  let t = 0;
  for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) t = Math.max(t, fs.statSync(path.join(f.parentPath, f.name)).mtimeMs);
  }
  return t;
}

/**
 * Build the UI (`npm run ui:build`, as `npm run test:a11y` does) when ui/dist
 * is missing or older than its sources or the shared types it imports.
 */
export function ensureUiBuilt(): void {
  const built = fs.existsSync(UI_INDEX) ? fs.statSync(UI_INDEX).mtimeMs : 0;
  if (built > Math.max(newest(path.join(REPO, "ui", "src")), newest(path.join(REPO, "shared")))) return;
  const r = spawnSync("npm", ["run", "ui:build"], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) throw new Error("npm run ui:build failed");
}
