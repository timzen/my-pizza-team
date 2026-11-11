// mpt-source-demo-tracker — a fake, offline issue tracker as an MPT Work Source plugin.
//
// A teaching example: everything a real tracker plugin (Jira, Asana, …) does,
// against a JSON file instead of an API, in plain JavaScript so it loads in place
// from a local path with no build step. See my-pizza-team GUIDE.md "Writing a
// Work Source plugin" and the `WorkSource` / `SourceContext` types.
//
// The "tracker" is one JSON file:
//
//   { "issues": [ { "id": "DEMO-1", "title": "…", "body": "…", "status": "open",
//                   "updatedAt": "2024-06-01T10:00:00Z", "comments": [] } ] }
//
//   - sync:           every *open* issue becomes an ExternalDef. MPT mirrors it
//                     (read-only) and runs it once per revision. An issue that is
//                     no longer open stops being reported, so MPT archives its mirror.
//   - onComment:      a comment on the issue's MPT thread is appended to `comments`.
//   - onItemTerminal: a finished run writes the outcome back — COMPLETE marks the
//                     issue "done", FAILED marks it "failed", CANCELED just leaves a note.
//
// Triage mode: an issue with `"mode": "triage"` (or every issue, with the plugin
// option `mode: "triage"`; an issue's own `mode` wins) isn't worked — a teammate
// *triages* it, like a note's Auto Triage, and proposes tasks/stories/schedules
// that you accept or reject in MPT (the issue's Triage tab). The daemon owns how
// such an item runs (title, prompt, Run = Triage now); the plugin only reports the
// mode. Write-back still applies, except that a finished triage never closes the
// issue — it was triaged, not done (see onItemTerminal).
//
// Settings from the UI: `configSchema` describes this package's `config` (file,
// directory, intervalSeconds, mode, urlBase), so MPT's Config → Sources tab shows
// a form for it; `preview` answers the tab's **Preview** (the open issues a sync
// would report with the *unsaved* settings — read-only, nothing mirrored); and
// **Save** writes config.json and calls `init` again, which re-reads
// `ctx.options()` — so every setting but `intervalSeconds`, `id` and `label`
// applies without a daemon restart. No `toggle` is declared: MPT gives every
// external source an on/off switch (`features.demo-tracker`) for free.
//
// Personas: the package also ships a persona (`personas/tracker-worker.md`,
// listed under package.json `"mpt": { "personas" }`), and the source names it
// as its `defaultPersona` — how MPT works this source's items unless the team
// picks another on Config → Sources, or a person overrides one item on its page
// (my-pizza-team docs/DESIGN.md "Work Source personas"). It declares no
// `triagePersona`, so a triage-mode issue (DEMO-3) needs the team to pick one:
// without it, the issue is mirrored but not run, and Config → Sources says why.
// The demo team's config.json sets `sourcePersonas.demo-tracker.triagePersona`.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
// Resolved by the daemon to *its own* copy of the host API (a peer dependency:
// never installed here), so this is always the running app's value.
import { WORK_SOURCE_API_VERSION } from "my-pizza-team/plugin";

/** @typedef {{ id: string, title: string, body?: string, acceptanceCriteria?: string, status: string, updatedAt?: string, mode?: "work" | "triage", comments?: { at: string, author: string, body: string }[] }} Issue */

/**
 * The default export is a factory: called once at daemon startup with this
 * package's `config` from the team's config.json `packages` entry (read-only).
 * @type {import("my-pizza-team/plugin").PluginFactory}
 */
export default function demoTracker(options, { teamDir }) {
  /**
   * The settings, with defaults. Paths are relative to the team directory.
   * Read from the factory's `options` first, then from `ctx.options()` on every
   * `init` (a Save on the Config page) — so keep reading them through `settings`.
   */
  function readSettings(opts) {
    return {
      file: path.resolve(teamDir, String(opts.file ?? "tracker.json")),
      directory: opts.directory ? path.resolve(teamDir, String(opts.directory)) : undefined,
      everySeconds: Number(opts.intervalSeconds ?? 10),
      urlBase: String(opts.urlBase ?? "https://tracker.example/browse/"),
      // The source-wide mode ("work" | "triage"); each issue may override it.
      mode: opts.mode === "triage" ? "triage" : "work",
    };
  }
  let settings = readSettings(options);

  /** An issue's effective mode: its own `mode`, else the plugin's. (MPT applies the same rule.) */
  function modeOf(issue) {
    return issue.mode === "triage" || issue.mode === "work" ? issue.mode : settings.mode;
  }

  /** @returns {{ issues: Issue[] }} */
  function readTracker(file = settings.file) {
    // A missing or broken file is an error: MPT logs it, backs off, and retries
    // (the "external system" is down); it never archives everything.
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.issues)) throw new Error(`${file}: expected { "issues": [...] }`);
    return data;
  }

  /** The open issues as ExternalDefs — what `sync` reports and `preview` shows. */
  function openIssueDefs(data, s) {
    return data.issues
      .filter((issue) => issue.status === "open")
      .map((issue) => ({
        externalId: issue.id,
        // The revision decides "is this a new version to run?". It covers what
        // the work *is* (title, body, updatedAt) and not the comments we append
        // ourselves, so our own write-back never re-triggers a run.
        revision: issue.updatedAt ?? hash([issue.title, issue.body, issue.acceptanceCriteria]),
        title: issue.title,
        goal: issue.body ?? issue.title,
        acceptanceCriteria: issue.acceptanceCriteria,
        directory: s.directory,
        url: s.urlBase + encodeURIComponent(issue.id),
        // Only when the issue sets one; otherwise the source's `mode` applies.
        // A mode change alone isn't a new revision: it applies from the next run.
        ...(issue.mode === "triage" || issue.mode === "work" ? { mode: issue.mode } : {}),
      }));
  }

  /** Read-modify-write one issue. Synchronous, so two write-backs never interleave. */
  function updateIssue(issueId, change, ctx) {
    try {
      const data = readTracker();
      const issue = data.issues.find((i) => i.id === issueId);
      if (!issue) return ctx.log(`write-back: no issue ${issueId} in ${settings.file}`);
      change(issue);
      fs.writeFileSync(settings.file, JSON.stringify(data, null, 2) + "\n");
    } catch (e) {
      // Write-back is fire-and-forget: log, never throw into the daemon.
      ctx.log(`write-back to ${issueId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function addComment(issue, author, body) {
    (issue.comments ??= []).push({ at: new Date().toISOString(), author, body });
  }

  /** @type {import("my-pizza-team/plugin").WorkSource} */
  const source = {
    id: String(options.id ?? "demo-tracker"), // lowercase + dashes; prefixes the mirrored WorkDef ids
    label: String(options.label ?? "Demo Tracker"), // the UI tab's name, and "Open in Demo Tracker"
    apiVersion: WORK_SOURCE_API_VERSION,
    // Read once, when MPT starts its timers: a changed interval applies after a restart.
    syncEveryMs: () => settings.everySeconds * 1000,
    // Triage mode for every item from this source (an ExternalDef's own `mode` wins).
    // A getter, so a Save that changes the `mode` setting applies to the next new revision.
    get mode() {
      return settings.mode;
    },
    // How MPT works this source's (work-mode) items unless the team or a person
    // picks another: this package's own persona, `<package.json name>/<file name>`.
    defaultPersona: "mpt-source-demo-tracker/tracker-worker",

    // The settings form (Config → Sources). A small JSON Schema with UI hints;
    // MPT also validates Preview / Save against it. `id` / `label` are left out
    // on purpose: they name the source, so they're set in config.json only.
    configSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          title: "Tracker file",
          description: "The tracker's JSON file, relative to the team directory.",
          default: "tracker.json",
          minLength: 1,
        },
        directory: {
          type: "string",
          title: "Working directory",
          description: "Where teammates work the issues (relative to the team directory). Empty: the team's default.",
          placeholder: "/path/to/the/project",
        },
        intervalSeconds: {
          type: "integer",
          title: "Sync interval (seconds)",
          description: "How often MPT syncs the tracker. Takes effect after a daemon restart.",
          default: 10,
          minimum: 1,
        },
        mode: {
          type: "string",
          title: "Mode",
          description: "work: a teammate works each issue. triage: a teammate proposes work for it instead (an issue's own mode wins).",
          enum: ["work", "triage"],
          default: "work",
        },
        urlBase: {
          type: "string",
          title: "Link prefix",
          description: "Each issue's (fake) link is this plus its id.",
          format: "uri",
          default: "https://tracker.example/browse/",
        },
      },
    },

    // Called at registration and again after every Save from the Config page:
    // idempotent — it replaces the settings, it doesn't add to anything.
    init(ctx) {
      settings = readSettings(ctx.options());
      ctx.log(`reading issues from ${settings.file} every ${settings.everySeconds}s (mode: ${settings.mode})`);
    },

    // Every open issue, as it reads *now*. MPT diffs this against its mirrors.
    async sync() {
      return openIssueDefs(readTracker(), settings);
    },

    // What `sync` would report with the draft settings: read-only (no write-back,
    // no ctx.upsertDef / enqueue), and a missing or broken file is a warning, not
    // an error, so the person can fix the path in the form.
    async preview(ctx, draftOptions) {
      const draft = readSettings(draftOptions);
      let data;
      try {
        data = readTracker(draft.file);
      } catch (e) {
        return { items: [], warnings: [`can't read the tracker: ${e instanceof Error ? e.message : String(e)}`] };
      }
      const items = openIssueDefs(data, draft);
      return {
        items,
        ...(items.length ? {} : { warnings: [`no open issues in ${draft.file}`] }),
        note: `${items.length} open of ${data.issues.length} issue(s) in ${path.basename(draft.file)}`,
      };
    },

    // A mirrored def's parent id is the issue's externalId.
    onComment(def, comment, ctx) {
      updateIssue(def.parent?.id, (issue) => addComment(issue, comment.from, comment.body), ctx);
    },

    onItemTerminal(def, item, ctx) {
      updateIssue(def.parent?.id, (issue) => {
        if (modeOf(issue) === "triage") {
          // A triage run produced proposals (accepted or rejected in MPT), not a
          // fix: leave the issue open. Its next revision is triaged again.
          addComment(issue, "mpt", `triage ${item.id} ended ${item.state}`);
          return;
        }
        if (item.state === "COMPLETE") issue.status = "done";
        else if (item.state === "FAILED") issue.status = "failed";
        addComment(issue, "mpt", `run ${item.id} ended ${item.state}`);
      }, ctx);
    },
  };
  return source;
}

/** A short content hash, for issues without an updatedAt. */
function hash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
