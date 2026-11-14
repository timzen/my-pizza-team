// A failed model call's error kind, as the Pi harness reads it.
//
// my-pizza-team docs/DESIGN.md "Model Failover": a `sessionError` goes to the
// daemon with an `errorKind` (throttle / 5xx / auth / context / other), which
// the team-wide failover trips on. Pi's AssistantMessage carries no HTTP
// status or exception object — only `stopReason: "error"` and the provider's
// error as text, which Pi's providers format in stable ways:
//
//   - Bedrock maps its SDK exception classes to fixed prefixes
//     (pi-ai bedrock-converse-stream `BEDROCK_ERROR_PREFIXES`):
//     "Throttling error:", "Service unavailable:", "Internal server error:",
//     "Model stream error:", "Validation error:".
//   - Other providers' HTTP errors read "<provider> API error (<status>): …"
//     (pi-ai `formatProviderError`), or start with the status.
//   - The SDK exception class may appear by name ("ThrottlingException",
//     "ServiceUnavailableException", "AccessDeniedException", …).
//
// Those precise readings come first; anything else falls back to the shared,
// provider-neutral `classifyModelError` the daemon also uses. Pure, so tests
// import it directly (harnesses/pi/tests/model-error.test.mjs). It imports the
// generated protocol copy by its `.ts` name, like runtime/ does, because Node's
// type stripping can't remap './x.js' — so it loads standalone in the tests.

import { classifyModelError, type ModelErrorKind } from "./shared/agent-protocol.ts";

/** Pi's Bedrock prefixes and SDK exception names, by kind. */
const NAMED: Array<[RegExp, ModelErrorKind]> = [
  [/^throttling error:|\bThrottlingException\b|\bTooManyRequestsException\b/i, "throttle"],
  [/^(service unavailable|internal server error|model stream error):|\b(ServiceUnavailableException|InternalServerException|ModelStreamErrorException|ModelNotReadyException)\b/i, "5xx"],
  [/\b(AccessDeniedException|UnrecognizedClientException|ExpiredTokenException|CredentialsProviderError)\b|could not load credentials/i, "auth"],
];

/** "<provider> API error (429): …" or a leading status — the HTTP status Pi's providers name. */
const STATUS = /\bAPI error \((\d{3})\)|^(\d{3})(?:\s|:|$)/i;

/**
 * The kind of a failed run's error: from Pi's formatted error text (status,
 * exception class), else the shared rule. `stopReason` other than "error"
 * (e.g. "length" with no output) is a context problem when it says so, and
 * otherwise "other".
 */
export function classifyPiModelError(errorMessage: string | null | undefined, stopReason?: string | null): ModelErrorKind {
  const text = (errorMessage ?? "").trim();
  for (const [re, kind] of NAMED) if (re.test(text)) return kind;
  const m = STATUS.exec(text);
  const status = m ? Number(m[1] ?? m[2]) : null;
  if (stopReason === "length" && !text) return "context";
  return classifyModelError(text, status);
}
