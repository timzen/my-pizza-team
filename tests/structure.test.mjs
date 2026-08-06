// Structure verification test
// Run with: node tests/structure.test.mjs
//
// Verifies the extension has the expected simplified structure after
// the daemon migration (no server, store, UI, or search modules).

import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..");

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

function exists(p) { return fs.existsSync(path.join(root, p)); }
function notExists(p) {
  if (fs.existsSync(path.join(root, p))) {
    throw new Error(`${p} should not exist`);
  }
}

console.log("Extension structure:");

// Expected files
test("src/index.ts exists", () => { if (!exists("src/index.ts")) throw new Error("missing"); });
test("src/client.ts exists", () => { if (!exists("src/client.ts")) throw new Error("missing"); });
test("src/leader.ts exists", () => { if (!exists("src/leader.ts")) throw new Error("missing"); });
test("src/teammate.ts exists", () => { if (!exists("src/teammate.ts")) throw new Error("missing"); });
test("src/assistant.ts exists", () => { if (!exists("src/assistant.ts")) throw new Error("missing"); });
test("src/tools.ts exists", () => { if (!exists("src/tools.ts")) throw new Error("missing"); });
test("src/permissions.ts exists", () => { if (!exists("src/permissions.ts")) throw new Error("missing"); });
test("src/readiness.ts exists", () => { if (!exists("src/readiness.ts")) throw new Error("missing"); });
test("src/shared/types.ts exists", () => { if (!exists("src/shared/types.ts")) throw new Error("missing"); });

// Removed files/dirs
test("src/lead/ directory removed", () => notExists("src/lead"));
test("src/lead/server.ts removed", () => notExists("src/lead/server.ts"));
test("src/lead/store.ts removed", () => notExists("src/lead/store.ts"));
test("src/lead/search.ts removed", () => notExists("src/lead/search.ts"));
test("src/lead/assets.ts removed", () => notExists("src/lead/assets.ts"));
test("src/lead/ui/ removed", () => notExists("src/lead/ui"));
test("src/teammate/ directory removed", () => notExists("src/teammate"));
test("src/assistant/ directory removed", () => notExists("src/assistant"));
test("src/shared/protocol.ts removed", () => notExists("src/shared/protocol.ts"));

// Package.json checks
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
test("version is 0.2.0", () => {
  if (pkg.version !== "0.2.0") throw new Error(`version is ${pkg.version}`);
});
test("no better-sqlite3 dependency", () => {
  if (pkg.dependencies?.["better-sqlite3"]) throw new Error("still has better-sqlite3");
  if (pkg.devDependencies?.["@types/better-sqlite3"]) throw new Error("still has @types/better-sqlite3");
});
test("no hono dependency", () => {
  if (pkg.dependencies?.hono) throw new Error("still has hono");
  if (pkg.dependencies?.["@hono/node-server"]) throw new Error("still has @hono/node-server");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
