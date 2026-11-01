/**
 * tests/attachment-upload.test.ts — The run thread's upload body
 * (ui/src/lib/attachment-upload.ts): which files go as base64, the encoding
 * itself, and the body for binary vs text files.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { attachmentUploadBody, bytesToBase64, isBinaryUpload } from "../ui/src/lib/attachment-upload.ts";

test("isBinaryUpload: images and octet-stream are binary; text types are not", () => {
  assertEquals(isBinaryUpload("image/png"), true);
  assertEquals(isBinaryUpload("application/octet-stream"), true);
  assertEquals(isBinaryUpload("text/plain"), false);
  assertEquals(isBinaryUpload("application/json"), false);
  assertEquals(isBinaryUpload(""), false);
});

test("bytesToBase64: matches Buffer's base64, including high bytes and empty input", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 72, 105]);
  assertEquals(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  assertEquals(bytesToBase64(new Uint8Array()), "");
  assertEquals(bytesToBase64(new TextEncoder().encode("hi")), "aGk=");
});

test("attachmentUploadBody: a binary file is base64 with encoding set", async () => {
  const file = new File([new Uint8Array([255, 0, 10])], "pic.png", { type: "image/png" });
  assertEquals(await attachmentUploadBody(file), { name: "pic.png", content: "/wAK", encoding: "base64" });
});

test("attachmentUploadBody: a text file is sent as text, encoding dropped from the JSON", async () => {
  const file = new File(["line 1\nline 2"], "notes.md", { type: "text/markdown" });
  const body = await attachmentUploadBody(file);
  assertEquals(body, { name: "notes.md", content: "line 1\nline 2", encoding: undefined });
  assertEquals(JSON.stringify(body), JSON.stringify({ name: "notes.md", content: "line 1\nline 2" }));
});
