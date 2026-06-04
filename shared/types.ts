/**
 * shared/types.ts — Shared type definitions used across daemon, CLI, and UI.
 */

/** Standard API response envelope. */
export interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string;
}
