/**
 * lib/attachment-upload.ts — The request body for a run-thread file upload
 * (`POST /api/work-defs/:id/attachments`, used by components/RunThread.tsx).
 *
 * Images and `application/octet-stream` files are read as bytes and sent
 * base64-encoded (`encoding: "base64"`); everything else is sent as text with
 * no `encoding`. Kept pure (no React) so it is unit-tested in
 * tests/attachment-upload.test.ts.
 */

/** The JSON body of an attachment upload. `encoding` is omitted for text. */
export interface AttachmentUploadBody {
  name: string;
  content: string;
  encoding?: string;
}

/** The parts of a browser `File` the upload reads (Node's `File` has them too). */
export interface UploadFile {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** Whether a file of this MIME type is uploaded as base64 bytes rather than text. */
export function isBinaryUpload(type: string): boolean {
  return type.startsWith("image/") || type === "application/octet-stream";
}

/**
 * Base64-encode raw bytes with `btoa`, which takes a "binary string" (one
 * char per byte), so the bytes are mapped to char codes first.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Build the upload body for `file`: base64 for binary types, text otherwise. */
export async function attachmentUploadBody(file: UploadFile): Promise<AttachmentUploadBody> {
  if (isBinaryUpload(file.type)) {
    const content = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    return { name: file.name, content, encoding: "base64" };
  }
  return { name: file.name, content: await file.text(), encoding: undefined };
}
