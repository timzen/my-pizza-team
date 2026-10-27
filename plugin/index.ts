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
 * triage mode) — are not breaking, so the version stays 1.
 */

export { WORK_SOURCE_API_VERSION } from "../daemon/sources/types.ts";
export { SOURCE_ID_PATTERN } from "../daemon/sources/registry.ts";

export type {
  ActiveSourceItems,
  EnqueueRevisionOptions,
  ExternalDef,
  ItemTerminalOutcome,
  RevisionCursor,
  RunResult,
  SourceContext,
  SourceKv,
  SourceToggle,
  WorkSource,
  WorkSourceMode,
} from "../daemon/sources/types.ts";

export type { PluginFactory, PluginFactoryContext } from "../daemon/plugins/loader.ts";

/** Types that appear in the hooks' signatures (a WorkDef, its WorkItems and thread comments, the team config). */
export type { Comment, TeamConfig, WorkDef, WorkItem } from "../shared/types.ts";
