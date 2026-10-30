/**
 * tests/source-settings-ui.test.ts — The Config page's Sources tab
 * (ui/src/lib/source-settings.ts): which sources it lists, their status pills,
 * the form generated from a `configSchema` and how its inputs shape the draft,
 * env-var fields (name only, set / not set), server field errors by field,
 * the JSON fallback, the dirty check, the toggle body, Preview/Save results,
 * and the navigate-away guard's link rule (ui/src/lib/unsaved-changes.ts).
 * See GUIDE.md "Setting up a plugin from the UI".
 */

import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import {
  defaultHint, envVarState, extraKeys, fieldErrorsByPath, formFields, isSourceEnabled, managedSources, mirrorCountLabel,
  numberValue, parseSettingsJson, previewItemMode, previewSummary, REDACTED_SETTING, relativeTime, saveOutcome, selectInput,
  selectValue, settingsDirty, settingsJson, sourceIdFromConfigPath, sourceSettingsPath, sourceStatus, stringListText,
  stringListValue, textValue, toggleConfigBody, unplacedErrors, valueAt, withValueAt, type SourceView,
} from "../ui/src/lib/source-settings.ts";
import { leavesPage } from "../ui/src/lib/unsaved-changes.ts";

const NOW = 1_700_000_000_000;

function view(over: Partial<SourceView> = {}): SourceView {
  return {
    id: "jira", label: "Jira", kind: "plugin", syncs: true, package: { spec: "npm:mpt-jira", identity: "npm:mpt-jira" },
    mode: "work", toggle: { feature: "jira", enabled: true }, configScope: "package", options: {}, redacted: [], envVars: [],
    configurable: true, previewable: true, sync: { running: false, failures: 0, backoffUntil: null, last: null }, activeMirrors: 0,
    persona: null, defaultPersona: null, triagePersona: null, defaultTriagePersona: null,
    ...over,
  };
}

const SCHEMA = {
  type: "object",
  required: ["project"],
  properties: {
    project: { type: "string", title: "Project key", placeholder: "ACME", description: "Which project" },
    tokenEnv: { type: "string", title: "Token", format: "env-var", default: "ACME_TOKEN" },
    status: { type: "string", enum: ["open", "all"], default: "open" },
    maxItems: { type: "integer", minimum: 1, default: 10 },
    watch: { type: "boolean", default: true },
    labels: { type: "array", items: { type: "string" } },
    kinds: { type: "array", items: { type: "string", enum: ["bug", "task"] } },
    filter: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "number" } } },
  },
};

test("routes: /config/sources/:id round-trips; other routes select nothing", () => {
  assertEquals(sourceSettingsPath("sim-t"), "/config/sources/sim-t");
  assertEquals(sourceIdFromConfigPath(sourceSettingsPath("sim-t")), "sim-t");
  assertEquals(sourceIdFromConfigPath("/config/sources"), null);
  assertEquals(sourceIdFromConfigPath("/config/workflows/x"), null);
  assertEquals(sourceIdFromConfigPath("/config/sources/a/b"), null);
});

test("managedSources: plugins and external sources, not the built-in kinds", () => {
  const list = [view({ id: "task", kind: "built-in" }), view({ id: "fixture", kind: "external" }), view()];
  assertEquals(managedSources(list).map((s) => s.id), ["fixture", "jira"]);
  assertEquals(managedSources(null), []);
});

test("sourceStatus: off, init failed, never synced, ok / failed with when, backoff", () => {
  assertEquals(sourceStatus(view({ toggle: { feature: "jira", enabled: false } }), NOW).label, "Off");
  assertEquals(isSourceEnabled(view({ toggle: null })), true, "no toggle = always on");
  const init = sourceStatus(view({ initError: "boom" }), NOW);
  assertEquals([init.label, init.tone, init.detail], ["Init failed", "bad", "boom"]);
  // A persona problem rides initError when init is fine; it's named for what it is.
  const msg = "triage-mode source jira needs a triage persona — set one on Config → Sources, or declare triagePersona";
  const persona = sourceStatus(view({ mode: "triage", initError: msg, personaError: msg }), NOW);
  assertEquals([persona.label, persona.tone, persona.detail], ["Needs a triage persona", "bad", msg]);
  // A real init failure still wins over a persona problem.
  assertEquals(sourceStatus(view({ initError: "boom", personaError: msg }), NOW).label, "Init failed");
  assertEquals(sourceStatus(view(), NOW).label, "Not synced yet");
  const last = { at: NOW - 5 * 60_000, ok: true, mirrored: 3, enqueued: 1, archived: 0, held: 0 };
  const ok = sourceStatus(view({ sync: { running: false, failures: 0, backoffUntil: null, last } }), NOW);
  assertEquals([ok.label, ok.tone], ["Synced 5m ago", "ok"]);
  assert(ok.detail!.includes("3 mirrored"));
  const bad = sourceStatus(view({ sync: { running: false, failures: 1, backoffUntil: null, last: { ...last, ok: false, error: "401" } } }), NOW);
  assertEquals([bad.label, bad.tone, bad.detail], ["Sync failed 5m ago", "bad", "401"]);
  const backoff = sourceStatus(view({ sync: { running: false, failures: 3, backoffUntil: NOW + 1000, last: { ...last, ok: false } } }), NOW);
  assertEquals(backoff.label, "Backing off (3 failed)");
  assertEquals(sourceStatus(view({ syncs: false, sync: null }), NOW).label, "On");
  assertEquals(relativeTime(NOW - 10_000, NOW), "just now");
  assertEquals(relativeTime(NOW - 3 * 3600_000, NOW), "3h ago");
  assertEquals(relativeTime(NOW - 3 * 86400_000, NOW), "3d ago");
  assertEquals(mirrorCountLabel({ activeMirrors: 1 }), "1 mirrored item");
  assertEquals(mirrorCountLabel({ activeMirrors: null }), null);
});

test("toggleConfigBody: the daemon's current config, read-only fields dropped, just this feature", () => {
  const body = toggleConfigBody({ port: 1, workflows: { a: {} }, featureUsage: {}, featureSources: [], defaultNouns: [], features: { stories: true, jira: true } }, "jira", false);
  assertEquals(body, { port: 1, workflows: { a: {} }, features: { jira: false } });
});

test("formFields: each schema type → its input, with hints, defaults, required, and one group level", () => {
  const fields = formFields(SCHEMA)!;
  assertEquals(fields.map((f) => [f.path.join("."), f.kind]), [
    ["project", "text"], ["tokenEnv", "env-var"], ["status", "select"], ["maxItems", "number"], ["watch", "boolean"],
    ["labels", "string-list"], ["kinds", "multi-select"], ["filter", "group"],
  ]);
  const project = fields[0]!;
  assertEquals([project.title, project.placeholder, project.description, project.required], ["Project key", "ACME", "Which project", true]);
  assertEquals(fields[3]!.integer, true);
  assertEquals(fields[2]!.title, "status", "title defaults to the key");
  assertEquals(fields[7]!.fields!.map((f) => [f.path.join("."), f.required]), [["filter.query", true], ["filter.limit", false]]);
  assertEquals(defaultHint(fields[3]!), "Default: 10");
  assertEquals(defaultHint(fields[4]!), "Default: on");
  assertEquals(defaultHint(project), null);
});

test("formFields: no schema, or one outside the subset → null (JSON editor)", () => {
  assertEquals(formFields(undefined), null);
  assertEquals(formFields({ type: "object", properties: { x: { type: "null" } } }), null);
  assertEquals(formFields({ type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: {} } } } } }), null, "two levels deep");
  assertEquals(formFields({ type: "object", properties: { a: { type: "array", items: { type: "number" } } } }), null);
  assertEquals(formFields({ type: "object", properties: {} }), [], "no settings is a form with no fields");
});

test("draft edits: set, clear (unset, not empty), nested groups pruned, other keys kept", () => {
  let d: Record<string, unknown> = { project: "A", extra: 1 };
  d = withValueAt(d, ["filter", "query"], "x");
  assertEquals(d, { project: "A", extra: 1, filter: { query: "x" } });
  assertEquals(valueAt(d, ["filter", "query"]), "x");
  d = withValueAt(d, ["filter", "query"], undefined);
  assertEquals(d, { project: "A", extra: 1 }, "an emptied group goes too");
  d = withValueAt(d, ["project"], textValue(""));
  assertEquals(d, { extra: 1 });
  assertEquals(extraKeys(formFields(SCHEMA)!, { project: "A", extra: 1 }), ["extra"]);
});

test("input parsing: numbers, string lists, selects", () => {
  assertEquals(numberValue(""), undefined);
  assertEquals(numberValue("12"), 12);
  assertEquals(numberValue("abc"), undefined);
  assertEquals(stringListValue("a\n b ,c\n\n"), ["a", "b", "c"]);
  assertEquals(stringListValue("  "), undefined);
  assertEquals(stringListText(["a", "b"]), "a\nb");
  assertEquals(stringListText("My RG"), "My RG", "a lone string (pre-schema config) shows as one line");
  assertEquals(stringListText(5), "");
  const numSelect = { options: [5, 10] };
  assertEquals(selectValue(numSelect, "1"), 10, "a numeric enum keeps its type");
  assertEquals(selectValue(numSelect, ""), undefined);
  assertEquals(selectInput(numSelect, 10), "1");
  assertEquals(selectInput(numSelect, 7), "");
});

test("env-var fields: set / not set for the saved name, unknown once changed, never a value", () => {
  const s = view({ envVars: [{ path: "tokenEnv", name: "ACME_TOKEN", set: true }, { path: "g.k", name: "OTHER", set: false }] });
  assertEquals(envVarState(s, ["tokenEnv"], "ACME_TOKEN"), "set");
  assertEquals(envVarState(s, ["g", "k"], "OTHER"), "not-set");
  assertEquals(envVarState(s, ["tokenEnv"], "NEW_NAME"), "unknown");
  assertEquals(envVarState(s, ["tokenEnv"], undefined), "none");
  assertEquals(envVarState(s, ["tokenEnv"], REDACTED_SETTING), "none");
});

test("fieldErrorsByPath / unplacedErrors: errors land on their field; the rest are listed", () => {
  const byPath = fieldErrorsByPath([
    { path: "project", message: "is required" },
    { path: "labels[1]", message: "must be a string" },
    { path: "filter.query", message: "is required" },
    { path: "", message: "must be an object" },
    { path: "bogus", message: "is not allowed" },
  ]);
  assertEquals(byPath.project, ["is required"]);
  assertEquals(byPath.labels, ["labels[1]: must be a string"]);
  assertEquals(byPath["filter.query"], ["is required"]);
  assertEquals(unplacedErrors(byPath, formFields(SCHEMA)), ["must be an object", "bogus: is not allowed"]);
  assertEquals(unplacedErrors(byPath, null).length, 5, "the JSON editor lists them all");
});

test("settingsDirty ignores key order; JSON fallback checks syntax and shape", () => {
  assertEquals(settingsDirty({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), false);
  assertEquals(settingsDirty({ a: 1 }, { a: 2 }), true);
  assertEquals(parseSettingsJson(settingsJson({ a: [1] })), { ok: true, options: { a: [1] } });
  assertEquals(parseSettingsJson(""), { ok: true, options: {} });
  const bad = parseSettingsJson("{ a: 1 }");
  assert(!bad.ok && bad.error.startsWith("Not valid JSON"));
  const arr = parseSettingsJson("[1]");
  assert(!arr.ok && arr.error.includes("object"));
});

test("Preview and Save results", () => {
  assertEquals(previewSummary([]), "Nothing would be pulled");
  assertEquals(previewSummary([{}, {}]), "2 items would be pulled");
  assertEquals(previewItemMode({}, { mode: "triage" }), "triage");
  assertEquals(previewItemMode({ mode: "work" }, { mode: "triage" }), "work");
  assertEquals(previewItemMode({}, {}), "work");
  assertEquals(saveOutcome({ success: true, reinit: [{ id: "jira", ok: true }] }).ok, true);
  assertEquals(saveOutcome({ success: true, reinit: [{ id: "a", ok: true }, { id: "b", ok: true }] }).message, "Saved — re-initialized a, b");
  const failed = saveOutcome({ success: true, reinit: [{ id: "jira", ok: false, error: "no token" }] });
  assertEquals([failed.ok, failed.message], [false, "Saved, but re-initializing failed: jira: no token"]);
  assertEquals(saveOutcome({ success: false, error: "the settings are invalid" }), { ok: false, message: "the settings are invalid" });
});

test("leavesPage: only a same-tab link to another page is guarded", () => {
  const here = { origin: "http://localhost:9999", pathname: "/config/sources/jira" };
  const click = (href: string | null, extra: Partial<{ target: string; newTab: boolean }> = {}) => ({ href, target: "", newTab: false, ...extra });
  assertEquals(leavesPage(click("http://localhost:9999/config/sources/other"), here), true);
  assertEquals(leavesPage(click("http://localhost:9999/work/board"), here), true);
  assertEquals(leavesPage(click("http://localhost:9999/config/sources/jira#x"), here), false, "same page");
  assertEquals(leavesPage(click("http://localhost:9999/help", { newTab: true }), here), false);
  assertEquals(leavesPage(click("https://jira.example/X-1", { target: "_blank" }), here), false);
  assertEquals(leavesPage(click("https://jira.example/X-1"), here), true);
  assertEquals(leavesPage(click(null), here), false);
});
