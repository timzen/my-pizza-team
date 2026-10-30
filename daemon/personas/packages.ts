/**
 * daemon/personas/packages.ts — Personas shipped by plugin packages.
 *
 * A plugin package may list persona files in its package.json
 * (`"mpt": { "personas": ["personas/*.md"] }`); each is registered here under
 * `<package.json name>/<file base name>` and is read-only (docs/DESIGN.md
 * "Persona packages"). This module is the in-memory registry the Store reads;
 * the plugin loader (daemon/plugins/loader.ts) feeds it at startup — packages
 * load once, like sources, so there is no hot reload.
 *
 * Package personas are linted at registration: a warning is returned for the
 * package's load status, and an error marks the persona `lintError` but still
 * registers it — references resolve to it rather than silently falling back
 * ("Validation never refuses a source").
 */

import { TEAM_PERSONA_ID_PATTERN, type Persona } from "../../shared/types.ts";
import { parsePersonaFile } from "./library.ts";
import { validatePersonaMarkdown } from "./lint.ts";

/** One persona file a package ships: its id within the package and its raw text. */
export interface PackagePersonaFile {
  name: string;
  raw: string;
}

/** What registering a package's personas produced, for its `PluginLoadStatus`. */
export interface PackagePersonaResult {
  /** Full ids registered (`<package>/<name>`). */
  personas: string[];
  errors: string[];
  warnings: string[];
}

/** The registry of package personas (one per daemon run). */
export class PackagePersonas {
  private byId = new Map<string, Persona>();
  /** Which spec identity claimed each package `name` (first wins). */
  private owners = new Map<string, string>();

  /**
   * Register a package's personas. A second, *different* package (identity) with
   * the same `name` is refused — the first wins, as the loader's identity dedupe
   * does. A file whose name isn't a valid id is skipped with an error.
   */
  register(pkg: { name: string; identity: string }, files: PackagePersonaFile[]): PackagePersonaResult {
    const result: PackagePersonaResult = { personas: [], errors: [], warnings: [] };
    if (!pkg.name) {
      result.errors.push("a package that ships personas needs a package.json \"name\"");
      return result;
    }
    const owner = this.owners.get(pkg.name);
    if (owner && owner !== pkg.identity) {
      result.errors.push(`another package (${owner}) already registered personas as "${pkg.name}"`);
      return result;
    }
    this.owners.set(pkg.name, pkg.identity);
    for (const file of files) {
      if (!TEAM_PERSONA_ID_PATTERN.test(file.name)) {
        result.errors.push(`persona file "${file.name}" is not a valid persona id (lowercase letters, digits, "-")`);
        continue;
      }
      const id = `${pkg.name}/${file.name}`;
      const persona = parsePersonaFile(id, file.raw, { kind: "package", name: pkg.name, identity: pkg.identity });
      const lint = validatePersonaMarkdown(persona.content);
      for (const w of lint.warnings) result.warnings.push(`persona ${id}: ${w}`);
      if (lint.errors.length > 0) {
        persona.lintError = lint.errors.join(" ");
        result.errors.push(`persona ${id}: ${persona.lintError}`);
      }
      this.byId.set(id, persona);
      result.personas.push(id);
    }
    return result;
  }

  /** One package persona by full id, or null. */
  get(id: string): Persona | null {
    return this.byId.get(id) ?? null;
  }

  /** Every package persona, sorted by id. */
  list(): Persona[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
