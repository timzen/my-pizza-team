/**
 * tests/lifecycle.test.ts — Verifies PID file management and shutdown logic.
 */

import { assertEquals } from "@std/assert";
import { writePidFile, removePidFile, isAlreadyRunning } from "../daemon/lifecycle.ts";
import * as path from "jsr:@std/path@^1";

function createTempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mpt-lifecycle-test-" });
}

Deno.test("writePidFile creates file with current PID", () => {
  const dir = createTempDir();
  try {
    const pidFile = writePidFile(dir);
    const content = Deno.readTextFileSync(pidFile);
    assertEquals(content, String(Deno.pid));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("removePidFile removes file when PID matches", () => {
  const dir = createTempDir();
  try {
    const pidFile = writePidFile(dir);
    removePidFile(pidFile);
    let exists = false;
    try { Deno.statSync(pidFile); exists = true; } catch { /* */ }
    assertEquals(exists, false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("removePidFile does NOT remove file when PID differs", () => {
  const dir = createTempDir();
  const pidFile = path.join(dir, "daemon.pid");
  try {
    Deno.writeTextFileSync(pidFile, "99999999");
    removePidFile(pidFile);
    // File should still exist because PID doesn't match
    const content = Deno.readTextFileSync(pidFile);
    assertEquals(content, "99999999");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("isAlreadyRunning returns false when no PID file", () => {
  const dir = createTempDir();
  try {
    const result = isAlreadyRunning(dir);
    assertEquals(result.running, false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("isAlreadyRunning returns false for invalid PID content", () => {
  const dir = createTempDir();
  const pidFile = path.join(dir, "daemon.pid");
  try {
    Deno.writeTextFileSync(pidFile, "not-a-number");
    const result = isAlreadyRunning(dir);
    assertEquals(result.running, false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
