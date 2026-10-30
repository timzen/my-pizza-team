/**
 * daemon/routes/personas.ts — The persona library (`/api/personas*`), workflow
 * state persona selection, and the 410 stubs for the APIs personas replaced.
 *
 * One library, three origins (docs/DESIGN.md "Personas: One Library, Selected by
 * Reference"): team personas (`personas/<id>.md`) are created, edited and
 * deleted here; built-in (`builtin:*`) and package (`<package>/<id>`) personas
 * are read-only — PUT/DELETE answer 409 "duplicate it to customize", and
 * `POST /:id/duplicate` copies any persona into the team library.
 *
 * - Every save is linted (daemon/personas/lint.ts): errors refuse it with 400,
 *   warnings come back with the saved persona.
 * - `GET /:id` carries `usedBy`; `DELETE` refuses a persona in use (409 + `usedBy`).
 * - `:id` matches the whole rest of the path (`:id{.+}`), since package ids
 *   contain `/`; clients should `encodeURIComponent` ids anyway.
 *
 * **Removed, answering 410 Gone with the replacement named** ("Routes"): the
 * context library (`/api/context*`), workflow state instruction files
 * (`/api/workflows/:name/instructions/:state`), and `triage.md`
 * (`/api/triage/instructions`). No shim: the only clients change in the same
 * story, and a shim would have to invent persona ids.
 */

import type { Context } from "hono";
import type { RouteContext } from "./types.ts";
import type { Persona, PersonaKind } from "../../shared/types.ts";
import type {
  DeletePersonaResponse, DuplicatePersonaRequest, PersonaResponse, PersonasResponse, PersonaUsageResponse,
  SavePersonaRequest, SavePersonaResponse, SetStatePersonaRequest, SetStatePersonaResponse, UpdatePersonaRequest,
} from "../../shared/protocol.ts";
import { validatePersonaMarkdown } from "../personas/lint.ts";
import { normalizeKinds } from "../personas/library.ts";

/** The 410 messages, naming what replaced each removed API. */
export const GONE = {
  context: "The context library was removed: use personas (/api/personas) for how to do the work, or put project knowledge in the project's AGENTS.md.",
  stateInstructions: "Workflow state instruction files were replaced by personas: edit them at /api/personas and select one with PUT /api/workflows/:name/states/:state { persona }.",
  triageInstructions: "triage.md was replaced by a persona: edit it at /api/personas and select it as config triage.persona (PUT /api/config { triage: { persona } }).",
} as const;

/** Why `READ_ONLY` personas refuse edits. */
const READ_ONLY_ERROR = (id: string) => `Persona "${id}" is read-only (built-in or from a package) — duplicate it to customize.`;

/**
 * The refusal for a request that still carries a context-library attachment
 * (`context` on a story/task, `contextRefs` on a WorkDef/template), or null.
 * Refused rather than ignored, so an old client learns the attachment is gone
 * instead of silently losing it.
 */
export function contextFieldRefusal(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { context?: unknown; contextRefs?: unknown };
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  return nonEmpty(b.context) || nonEmpty(b.contextRefs) ? GONE.context : null;
}

/** Sort a library listing for a picker: personas hinted for `kind` first, the rest after (stable). */
export function sortForKind(personas: Persona[], kind: PersonaKind | undefined): Persona[] {
  if (!kind) return personas;
  const hinted = personas.filter((p) => p.kinds?.includes(kind));
  return [...hinted, ...personas.filter((p) => !p.kinds?.includes(kind))];
}

export function registerPersonaRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── Removed APIs (410 Gone) ───────────────────────────────────────
  app.all("/api/context", (c) => c.json({ success: false, error: GONE.context }, 410));
  app.all("/api/context/*", (c) => c.json({ success: false, error: GONE.context }, 410));
  app.all("/api/workflows/:name/instructions/:state", (c) => c.json({ success: false, error: GONE.stateInstructions }, 410));
  app.all("/api/triage/instructions", (c) => c.json({ success: false, error: GONE.triageInstructions }, 410));

  // ─── Library ───────────────────────────────────────────────────────

  app.get("/api/personas", (c) => {
    const kind = normalizeKinds([c.req.query("kind")])[0];
    return c.json({ personas: sortForKind(store.listPersonas(), kind) } satisfies PersonasResponse);
  });

  app.post("/api/personas", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Partial<SavePersonaRequest>;
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" } satisfies SavePersonaResponse, 400);
    if (typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required and must be a string" } satisfies SavePersonaResponse, 400);
    if (body.id !== undefined && typeof body.id !== "string") return c.json({ success: false, error: "Field 'id' must be a string" } satisfies SavePersonaResponse, 400);
    const lint = validatePersonaMarkdown(body.content);
    if (lint.errors.length > 0) return lintRefusal(c, lint);
    const res = store.createPersona({
      id: body.id, title: body.title, content: body.content,
      description: typeof body.description === "string" ? body.description : "",
      tags: stringList(body.tags), kinds: normalizeKinds(body.kinds),
    });
    if (!res.ok) return c.json({ success: false, error: res.error } satisfies SavePersonaResponse, res.status);
    return c.json({ success: true, persona: res.persona, warnings: lint.warnings } satisfies SavePersonaResponse, 201);
  });

  // The suffixed routes come before the bare `:id{.+}` ones, which would otherwise swallow them.
  app.get("/api/personas/:id{.+}/usage", (c) => {
    const id = c.req.param("id");
    if (!store.getPersona(id)) return c.json({ success: false, error: `Persona "${id}" not found` }, 404);
    return c.json({ usedBy: store.getPersonaUsage(id) } satisfies PersonaUsageResponse);
  });

  app.post("/api/personas/:id{.+}/duplicate", async (c) => {
    const body = await c.req.json().catch(() => ({})) as DuplicatePersonaRequest;
    const res = store.duplicatePersona(c.req.param("id"), {
      id: typeof body.id === "string" ? body.id : undefined,
      title: typeof body.title === "string" && body.title ? body.title : undefined,
    });
    if (!res.ok) return c.json({ success: false, error: res.error } satisfies SavePersonaResponse, res.status);
    return c.json({ success: true, persona: res.persona, warnings: validatePersonaMarkdown(res.persona.content).warnings } satisfies SavePersonaResponse, 201);
  });

  app.get("/api/personas/:id{.+}", (c) => {
    const id = c.req.param("id");
    const persona = store.getPersona(id);
    if (!persona) return c.json({ success: false, error: `Persona "${id}" not found` } satisfies PersonaResponse, 404);
    return c.json({ persona, usedBy: store.getPersonaUsage(id) } satisfies PersonaResponse);
  });

  app.put("/api/personas/:id{.+}", async (c) => {
    const id = c.req.param("id");
    const existing = store.getPersona(id);
    if (!existing) return c.json({ success: false, error: `Persona "${id}" not found` } satisfies SavePersonaResponse, 404);
    if (existing.readOnly) return c.json({ success: false, error: READ_ONLY_ERROR(id) } satisfies SavePersonaResponse, 409);
    const body = await c.req.json().catch(() => ({})) as UpdatePersonaRequest;
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title)) return c.json({ success: false, error: "Field 'title' must be a non-empty string" } satisfies SavePersonaResponse, 400);
    if (body.content !== undefined && typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' must be a string" } satisfies SavePersonaResponse, 400);
    const lint = validatePersonaMarkdown(body.content ?? existing.content);
    if (lint.errors.length > 0) return lintRefusal(c, lint);
    const persona = store.updatePersona(id, {
      title: body.title,
      description: typeof body.description === "string" ? body.description : undefined,
      tags: body.tags !== undefined ? stringList(body.tags) : undefined,
      kinds: body.kinds !== undefined ? normalizeKinds(body.kinds) : undefined,
      content: body.content,
    });
    if (!persona) return c.json({ success: false, error: `Persona "${id}" not found` } satisfies SavePersonaResponse, 404);
    return c.json({ success: true, persona, warnings: lint.warnings } satisfies SavePersonaResponse);
  });

  app.delete("/api/personas/:id{.+}", (c) => {
    const id = c.req.param("id");
    const existing = store.getPersona(id);
    if (!existing) return c.json({ success: false, error: `Persona "${id}" not found` } satisfies DeletePersonaResponse, 404);
    if (existing.readOnly) return c.json({ success: false, error: READ_ONLY_ERROR(id) } satisfies DeletePersonaResponse, 409);
    // No force flag: re-point the users first (docs/DESIGN.md "'Used by' and delete protection").
    const usedBy = store.getPersonaUsage(id);
    if (usedBy.length > 0) {
      return c.json({ success: false, error: `Persona "${id}" is in use (${usedBy.length}) — re-point its users first.`, usedBy } satisfies DeletePersonaResponse, 409);
    }
    store.deletePersona(id);
    return c.json({ success: true } satisfies DeletePersonaResponse);
  });

  // ─── Workflow state selection ──────────────────────────────────────

  app.put("/api/workflows/:name/states/:state", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Partial<SetStatePersonaRequest>;
    if (body.persona !== null && typeof body.persona !== "string") {
      return c.json({ success: false, error: "Field 'persona' must be a persona id or null" } satisfies SetStatePersonaResponse, 400);
    }
    const res = store.setStatePersona(c.req.param("name"), c.req.param("state"), body.persona || null);
    if (!res.ok) return c.json({ success: false, error: res.error } satisfies SetStatePersonaResponse, res.status);
    return c.json({ success: true, workflow: res.workflow } satisfies SetStatePersonaResponse);
  });
}

/** The 400 for a persona whose lint has errors (it would mangle the prompt). */
function lintRefusal(c: Context, lint: { errors: string[]; warnings: string[] }) {
  return c.json({ success: false, error: lint.errors.join(" "), errors: lint.errors, warnings: lint.warnings } satisfies SavePersonaResponse, 400);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim()) : [];
}
