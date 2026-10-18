/**
 * tests/lifecycle.test.ts — Verifies PID file management and shutdown logic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { writePidFile, removePidFile, isAlreadyRunning } from "../daemon/lifecycle.ts";
import * as path from "node:path";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mpt-lifecycle-test-"));
}

test("writePidFile creates file with current PID", () => {
  const dir = createTempDir();
  try {
    const pidFile = writePidFile(dir);
    const content = fs.readFileSync(pidFile, "utf8");
    assertEquals(content, String(process.pid));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removePidFile removes file when PID matches", () => {
  const dir = createTempDir();
  try {
    const pidFile = writePidFile(dir);
    removePidFile(pidFile);
    let exists = false;
    try { fs.statSync(pidFile); exists = true; } catch { /* */ }
    assertEquals(exists, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removePidFile does NOT remove file when PID differs", () => {
  const dir = createTempDir();
  const pidFile = path.join(dir, "daemon.pid");
  try {
    fs.writeFileSync(pidFile, "99999999");
    removePidFile(pidFile);
    // File should still exist because PID doesn't match
    const content = fs.readFileSync(pidFile, "utf8");
    assertEquals(content, "99999999");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isAlreadyRunning returns false when no PID file", () => {
  const dir = createTempDir();
  try {
    const result = isAlreadyRunning(dir);
    assertEquals(result.running, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isAlreadyRunning returns false for invalid PID content", () => {
  const dir = createTempDir();
  const pidFile = path.join(dir, "daemon.pid");
  try {
    fs.writeFileSync(pidFile, "not-a-number");
    const result = isAlreadyRunning(dir);
    assertEquals(result.running, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
