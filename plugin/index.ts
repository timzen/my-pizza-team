/**
 * plugin/index.ts — The public plugin surface: `import … from "my-pizza-team/plugin"`.
 * See GUIDE.md "Writing a Work Source plugin" and docs/DESIGN.md "Plugin packages".
 *
 * Everything a Work Source plugin author needs from the host and nothing
 * store-internal: the `WorkSource` interface and the `SourceContext` it is
 * handed (plus the types in their signatures), and the two runtime constants a
 * source checks itself against. Published as the package's `./plugin` subpath
 * export (compiled to dist/plugin/index.js + .d.ts).
 *
 * Plugins declare `"peerDependencies": { "my-pizza-team": "*" }` and don't
 * install their own copy: at load time the daemon maps the specifier to *its*
 * copy of this module (daemon/plugins/host-resolve.ts), the way pi maps its
 * extensions' imports to the running pi — so the constants are the host's
 * values, never a stale bundled copy.
 *
 * Keep this list deliberate: whatever is exported here is API. Breaking a type
 * means bumping `WORK_SOURCE_API_VERSION`. Additive changes — a new optional
 * field or type, like `WorkSource.mode` / `ExternalDef.mode` (`WorkSourceMode`,
 * triage mode), or `toggle: null` — are not breaking, so the version stays 1.
 *
 * On/off: an external source (one that declares `sync`) is switchable from the
 * Config page without declaring anything — the daemon gives it the toggle
 * `{ feature: <id> }` (`features.<id>` in config.json). While it's off the
 * daemon doesn't call its `sync` or `tick`, and `ctx.upsertDef` / `ctx.enqueue`
 * return null; a person can also *disconnect* it (switch off and archive its
 * mirrors). Declare `toggle: { feature }` to pick the name, or `toggle: null`
 * to stay always on. A feature name must be unique and not a built-in's
 * (stories, tasks, schedules), or the source is refused at load.
 *
 * Settings and preview (also additive, apiVersion 1): `configSchema`
 * (`SourceConfigSchema`, a small JSON Schema subset with UI hints) describes
 * the source's settings block — the whole package entry `config`, or with
 * `configScope: "source"` its `config[<id>]` (recommended when a package ships
 * several sources) — for the Config page's form and the daemon's validation;
 * `preview(ctx, draftOptions)` returns what a sync with draft settings would
 * pull (`SourcePreview`), on a ctx that can't mirror, enqueue, or persist kv.
 * Without `preview`, the daemon previews by running `sync` on that ctx.
 *
 * A mirrored thread (also additive, apiVersion 1): `ExternalDef.comments`
 * (`ExternalComment[]`) reports the item's comments, merged into the mirror's
 * thread by their `externalId` and marked `Comment.external` (`CommentExternal`:
 * source, id, channel, author) — never a new revision, never written back.
 * `onComment` may return `CommentWriteBack` (`{ externalId }`), the id of the
 * comment it posted, so that post isn't pulled in again.
 */

export { WORK_SOURCE_API_VERSION } from "../daemon/sources/types.ts";
export { SOURCE_ID_PATTERN } from "../daemon/sources/registry.ts";

export type {
  ActiveSourceItems,
  CommentWriteBack,
  EnqueueRevisionOptions,
  ExternalComment,
  ExternalDef,
  ItemTerminalOutcome,
  RevisionCursor,
  RunResult,
  SourceConfigBooleanField,
  SourceConfigField,
  SourceConfigFieldHints,
  SourceConfigLeafField,
  SourceConfigNumberField,
  SourceConfigObjectField,
  SourceConfigSchema,
  SourceConfigScope,
  SourceConfigStringArrayField,
  SourceConfigStringField,
  SourceContext,
  SourceKv,
  SourcePreview,
  SourceToggle,
  WorkSource,
  WorkSourceMode,
} from "../daemon/sources/types.ts";

export type { PluginFactory, PluginFactoryContext } from "../daemon/plugins/loader.ts";

/** Types that appear in the hooks' signatures (a WorkDef, its WorkItems and thread comments, the team config). */
export type { Comment, CommentExternal, TeamConfig, WorkDef, WorkItem } from "../shared/types.ts";
