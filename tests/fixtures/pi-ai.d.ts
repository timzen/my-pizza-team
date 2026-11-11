/**
 * tests/fixtures/pi-ai.d.ts — the little of `@earendil-works/pi-ai` that
 * tests/fixtures/pi-scripted-provider.ts uses, declared for the root typecheck.
 *
 * The root package doesn't depend on Pi (only harnesses/pi/ does, as a dev
 * dependency), so the module can't be resolved from tests/. At runtime the
 * fixture never resolves it either: Pi's extension loader aliases the specifier
 * to its own bundled copy. These declarations mirror the shapes in pi-ai's
 * dist/types.d.ts, dist/utils/event-stream.d.ts and dist/utils/transcript.d.ts
 * (Pi 0.87) — only the fields the fixture reads or writes.
 */

declare module "@earendil-works/pi-ai" {
  export interface TextContent { type: "text"; text: string }
  export interface ThinkingContent { type: "thinking"; thinking: string }
  export interface ImageContent { type: "image"; data: string; mimeType: string }
  export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  }

  export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

  export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: string;
    provider: string;
    model: string;
    usage: Usage;
    stopReason: StopReason;
    errorMessage?: string;
    timestamp: number;
  }

  export type TranscriptMessage =
    | { role: "system"; content: string | TextContent[]; timestamp: number }
    | { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
    | AssistantMessage
    | { role: "toolResult"; toolCallId: string; toolName: string; content: (TextContent | ImageContent)[]; isError: boolean; timestamp: number };

  export interface TranscriptContext { messages: TranscriptMessage[] }

  export interface Tool { name: string; description: string; parameters: unknown }

  export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }
  export interface Model { id: string; api: string; provider: string; cost: ModelCost }

  export interface SimpleStreamOptions {
    signal?: AbortSignal;
    onPayload?: (payload: unknown, model: Model) => unknown | undefined | Promise<unknown | undefined>;
    onResponse?: (response: { status: number; headers: Record<string, string> }, model: Model) => void | Promise<void>;
  }

  export type AssistantMessageEvent =
    | { type: "start"; partial: AssistantMessage }
    | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
    | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
    | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

  export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
    push(event: AssistantMessageEvent): void;
    end(result?: AssistantMessage): void;
  }

  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
  export function getCurrentSystemPrompt(messages: readonly { role: string }[]): string;
  export function getCurrentTools(messages: readonly { role: string }[]): Tool[];
}
