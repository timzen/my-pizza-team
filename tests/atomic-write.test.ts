/**
 * tests/atomic-write.test.ts — `writeFileAtomic` (shared/atomic-write.ts).
 *
 * Covers: creating and replacing a file (string and bytes), that no temp file is
 * left beside the target, that a failed write leaves the target as it was and
 * cleans up its temp, and that a missing directory is an error, not a stray file.
 */

import { afterEach, beforeEach, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert, assertEquals, assertThrows } from "./_assert.ts";
import { writeFileAtomic } from "../shared/atomic-write.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-atomic-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeFileAtomic creates a new file and leaves no temp behind", () => {
  const file = path.join(dir, "a.json");
  writeFileAtomic(file, "{}\n");
  assertEquals(fs.readFileSync(file, "utf8"), "{}\n");
  assertEquals(fs.readdirSync(dir), ["a.json"]);
});

test("writeFileAtomic replaces an existing file's whole content", () => {
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a much longer original content\n");
  writeFileAtomic(file, "short\n");
  assertEquals(fs.readFileSync(file, "utf8"), "short\n");
  assertEquals(fs.readdirSync(dir), ["a.txt"]);
});

test("writeFileAtomic writes bytes", () => {
  const file = path.join(dir, "b.bin");
  writeFileAtomic(file, new Uint8Array([0, 1, 2, 255]));
  assertEquals([...fs.readFileSync(file)], [0, 1, 2, 255]);
});

test("writeFileAtomic failing to rename keeps the target and removes the temp", () => {
  // A directory in the target's place makes the rename fail after the temp is written.
  const target = path.join(dir, "taken");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "kept");
  assertThrows(() => writeFileAtomic(target, "new"));
  assert(fs.statSync(target).isDirectory());
  assertEquals(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "kept");
  assertEquals(fs.readdirSync(dir), ["taken"]);
});

test("writeFileAtomic into a missing directory throws and creates nothing", () => {
  const file = path.join(dir, "missing", "d.json");
  assertThrows(() => writeFileAtomic(file, "x"));
  assertEquals(fs.readdirSync(dir), []);
});
