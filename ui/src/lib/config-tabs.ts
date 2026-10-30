/**
 * lib/config-tabs.ts — The Config page's tabs: which exist, which route each
 * lives at, which one a route shows, and which ones ride the page's global
 * "Save Configuration" button.
 *
 * Config is the home for team-wide settings and libraries: General, Teammates,
 * Sources (Work Source plugins: on/off, settings form, Preview — list +
 * `/config/sources/:id`), Workflows (list + `/config/workflows/:name` detail), Personas
 * (the persona library — list + `/config/personas/:id`), Triage (auto-triage
 * settings + the triage persona), and Theme. Workflows used to be its own page
 * (`/workflows`); the context library (`/context`, later `/config/context`) was
 * replaced by personas. Those URLs now redirect here (`legacyConfigPath`).
 *
 * Kept pure (no React) so the rules are unit-tested (tests/config-tabs.test.ts).
 */

import { filterByFeatures, type FeatureName, type Features } from "./features.ts";

/** One Config tab. */
export type ConfigTab = "general" | "teammates" | "sources" | "workflows" | "personas" | "triage" | "theme";

/** A tab's route, label, gating feature, and whether it edits the daemon config draft. */
export interface ConfigTabDef {
  tab: ConfigTab;
  path: string;
  label: string;
  /** Hidden while this work-item kind is off (Workflows only apply to stories). */
  feature?: FeatureName;
  /**
   * True for tabs that edit the page's config.json draft, so they show the
   * global Save button. Sources, Workflows and Personas save through their own flows;
   * Theme is a browser preference applied immediately.
   */
  savesConfig: boolean;
}

/** Every Config tab, in display order. */
export const CONFIG_TABS: readonly ConfigTabDef[] = [
  { tab: "general", path: "/config", label: "General", savesConfig: true },
  { tab: "teammates", path: "/config/teammates", label: "Teammates", savesConfig: true },
  { tab: "sources", path: "/config/sources", label: "Sources", savesConfig: false },
  { tab: "workflows", path: "/config/workflows", label: "Workflows", feature: "stories", savesConfig: false },
  { tab: "personas", path: "/config/personas", label: "Personas", savesConfig: false },
  { tab: "triage", path: "/config/triage", label: "Triage", savesConfig: true },
  { tab: "theme", path: "/config/theme", label: "Theme", savesConfig: false },
];

/**
 * The tab a Config route shows, from its second path segment — so a workflow's
 * detail (`/config/workflows/:name`) keeps the Workflows tab lit, a source's
 * settings (`/config/sources/:id`) the Sources tab, and a persona
 * (`/config/personas/:id`) the Personas tab. Unknown or
 * absent segments fall back to General.
 */
export function configTabFromPath(pathname: string): ConfigTab {
  const segment = pathname.split("/").filter(Boolean)[1];
  const match = CONFIG_TABS.find((t) => t.tab !== "general" && t.tab === segment);
  return match?.tab ?? "general";
}

/** The tabs to show for the team's feature toggles (Workflows hidden while Stories are off). */
export function visibleConfigTabs(features: Features | null): ConfigTabDef[] {
  return filterByFeatures(CONFIG_TABS, features);
}

/** Does this tab edit the daemon config draft (and so show the global Save button)? */
export function tabSavesConfig(tab: ConfigTab): boolean {
  return CONFIG_TABS.find((t) => t.tab === tab)?.savesConfig ?? false;
}

/** The detail route for a workflow (the Workflows tab's drill-down). */
export function workflowPath(name: string): string {
  return `/config/workflows/${encodeURIComponent(name)}`;
}

/**
 * Where a retired URL now lives: `/workflows` → `/config/workflows`,
 * `/workflows/:name` → `/config/workflows/:name`, and the removed context
 * library's `/context` and `/config/context` → `/config/personas` (personas
 * replaced it; docs/DESIGN.md "Personas"). Null for any other path. App.tsx redirects these with `replace`, so old bookmarks
 * and links keep working without leaving a dead history entry.
 */
export function legacyConfigPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "context" && segments.length === 1) return "/config/personas";
  if (segments[0] === "config" && segments[1] === "context" && segments.length === 2) return "/config/personas";
  if (segments[0] === "workflows") {
    if (segments.length === 1) return "/config/workflows";
    // Segments come from the URL already encoded; keep them as they are.
    if (segments.length === 2) return `/config/workflows/${segments[1]}`;
  }
  return null;
}
