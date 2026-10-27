/**
 * daemon/sources/config-schema.ts — A Work Source's settings: where its block
 * lives in the package entry's `config`, and validation against its
 * `configSchema`. See docs/DESIGN.md "Plugin settings: configSchema and preview".
 *
 * The schema language is a deliberately small subset of JSON Schema
 * (`SourceConfigSchema`, daemon/sources/types.ts): an object of string /
 * number / integer / boolean / enum / string-array fields, nested objects one
 * level deep. This in-house validator covers exactly that subset — enough for a
 * settings form, without a JSON Schema dependency — and reports **field-level**
 * errors (`{ path, message }`) the Config page can put under each input.
 *
 * Pure: no Store, no file system. The loader (daemon/plugins/loader.ts) calls it
 * at load time and logs what it finds (never refusing a source); the preview
 * (daemon/sources/preview.ts) refuses invalid drafts with these errors.
 */

import type {
  SourceConfigField,
  SourceConfigLeafField,
  SourceConfigSchema,
  SourceConfigScope,
  WorkSource,
} from "./types.ts";

/** One problem with one settings field. `path` is `""` for the block itself, else `key`, `group.key`, or `list[2]`. */
export interface ConfigFieldError {
  path: string;
  message: string;
}

/** An environment variable name, as `format: "env-var"` requires (the name, never the secret). */
export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LEAF_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A source's effective `configScope` (default `"package"`). */
export function configScopeOf(source: Pick<WorkSource, "configScope">): SourceConfigScope {
  return source.configScope === "source" ? "source" : "package";
}

/**
 * The source's settings block within its package entry's `config`: the whole
 * config (`"package"` scope), or `config[<sourceId>]` (`"source"` scope; `{}`
 * when absent or not an object).
 */
export function sourceConfigBlock(
  source: Pick<WorkSource, "id" | "configScope">,
  entryConfig: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (configScopeOf(source) === "package") return { ...entryConfig };
  const block = entryConfig[source.id];
  return isPlainObject(block) ? { ...block } : {};
}

/**
 * The package entry's `config` with this source's block replaced by `block`
 * (the inverse of `sourceConfigBlock`): `block` itself for `"package"` scope,
 * else `{ ...entryConfig, [sourceId]: block }` — so the other sources' blocks
 * in a multi-source package are kept. What a Save writes, and what a preview's
 * `ctx.options()` returns.
 */
export function withSourceConfigBlock(
  source: Pick<WorkSource, "id" | "configScope">,
  entryConfig: Readonly<Record<string, unknown>>,
  block: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (configScopeOf(source) === "package") return { ...block };
  return { ...entryConfig, [source.id]: { ...block } };
}

/**
 * Problems with a schema itself (outside the supported subset), as messages.
 * Empty = usable. The loader logs these; an unusable schema is skipped when
 * validating rather than failing every value.
 */
export function checkConfigSchema(schema: unknown): string[] {
  if (!isPlainObject(schema)) return ["configSchema must be an object"];
  if (schema.type !== "object") return ['configSchema must have type "object"'];
  return checkObjectShape(schema, "", true);
}

/** Check an object schema's `properties`/`required`; `allowNested` = its properties may be objects (top level only). */
function checkObjectShape(schema: Record<string, unknown>, at: string, allowNested: boolean): string[] {
  const where = at ? `configSchema property "${at}"` : "configSchema";
  if (!isPlainObject(schema.properties)) return [`${where}: "properties" must be an object`];
  const out: string[] = [];
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string"))) {
    out.push(`${where}: "required" must be an array of property names`);
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    const path = at ? `${at}.${key}` : key;
    if (!isPlainObject(field)) {
      out.push(`configSchema property "${path}" must be an object`);
      continue;
    }
    if (field.type === "object") {
      if (!allowNested) out.push(`configSchema property "${path}": objects nest one level only`);
      else out.push(...checkObjectShape(field, path, false));
      continue;
    }
    if (typeof field.type !== "string" || !LEAF_TYPES.has(field.type)) {
      out.push(`configSchema property "${path}": unsupported type ${JSON.stringify(field.type)} (use string, number, integer, boolean, array, or object)`);
      continue;
    }
    if (field.type === "array" && (!isPlainObject(field.items) || field.items.type !== "string")) {
      out.push(`configSchema property "${path}": arrays must have items: { type: "string" }`);
    }
    if (field.enum !== undefined && !Array.isArray(field.enum)) out.push(`configSchema property "${path}": "enum" must be an array`);
    const pattern = field.type === "array" && isPlainObject(field.items) ? field.items.pattern : field.pattern;
    if (pattern !== undefined && !compiles(pattern)) out.push(`configSchema property "${path}": "pattern" is not a valid regular expression`);
  }
  return out;
}

function compiles(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a settings block against a source's schema. Returns every problem
 * (empty = valid), field by field. A missing optional field is fine (its
 * `default` is the source's business); `null` counts as missing. An unusable
 * schema (`checkConfigSchema` non-empty) validates nothing beyond "is an object".
 */
export function validateSourceConfig(schema: SourceConfigSchema, value: unknown): ConfigFieldError[] {
  if (!isPlainObject(value)) return [{ path: "", message: "must be an object" }];
  if (checkConfigSchema(schema).length) return [];
  return validateObject(schema, value, "");
}

function validateObject(
  schema: { properties: Readonly<Record<string, SourceConfigField>>; required?: readonly string[]; additionalProperties?: boolean },
  value: Record<string, unknown>,
  at: string,
): ConfigFieldError[] {
  const out: ConfigFieldError[] = [];
  const join = (key: string) => (at ? `${at}.${key}` : key);
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null || value[key] === "") out.push({ path: join(key), message: "is required" });
  }
  for (const [key, v] of Object.entries(value)) {
    const field = schema.properties[key];
    if (!field) {
      if (schema.additionalProperties === false) out.push({ path: join(key), message: "is not a known setting" });
      continue;
    }
    if (v === undefined || v === null) continue;
    if (field.type === "object") {
      if (!isPlainObject(v)) out.push({ path: join(key), message: "must be an object" });
      else out.push(...validateObject(field, v, join(key)));
      continue;
    }
    out.push(...validateLeaf(field, v, join(key)));
  }
  return out;
}

function validateLeaf(field: SourceConfigLeafField, v: unknown, path: string): ConfigFieldError[] {
  const err = (message: string): ConfigFieldError[] => [{ path, message }];
  switch (field.type) {
    case "string":
      return validateString(field, v, path);
    case "number":
    case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v)) return err("must be a number");
      if (field.type === "integer" && !Number.isInteger(v)) return err("must be a whole number");
      if (field.enum && !field.enum.includes(v)) return err(`must be one of ${field.enum.join(", ")}`);
      if (field.minimum !== undefined && v < field.minimum) return err(`must be at least ${field.minimum}`);
      if (field.maximum !== undefined && v > field.maximum) return err(`must be at most ${field.maximum}`);
      return [];
    }
    case "boolean":
      return typeof v === "boolean" ? [] : err("must be true or false");
    case "array": {
      if (!Array.isArray(v)) return err("must be a list");
      if (field.minItems !== undefined && v.length < field.minItems) return err(`must have at least ${field.minItems} item(s)`);
      if (field.maxItems !== undefined && v.length > field.maxItems) return err(`must have at most ${field.maxItems} item(s)`);
      if (field.uniqueItems && new Set(v).size !== v.length) return err("must not repeat an item");
      return v.flatMap((item, i) => validateString(field.items, item, `${path}[${i}]`));
    }
  }
}

function validateString(
  field: { enum?: readonly string[]; format?: string; minLength?: number; maxLength?: number; pattern?: string },
  v: unknown,
  path: string,
): ConfigFieldError[] {
  const err = (message: string): ConfigFieldError[] => [{ path, message }];
  if (typeof v !== "string") return err("must be text");
  if (field.enum && !field.enum.includes(v)) return err(`must be one of ${field.enum.join(", ")}`);
  if (field.minLength !== undefined && v.length < field.minLength) return err(`must be at least ${field.minLength} character(s)`);
  if (field.maxLength !== undefined && v.length > field.maxLength) return err(`must be at most ${field.maxLength} character(s)`);
  if (field.pattern !== undefined && compiles(field.pattern) && !new RegExp(field.pattern).test(v)) return err(`must match ${field.pattern}`);
  // Secrets are referenced by env var name, never inline (docs/DESIGN.md "Plugin packages").
  if (field.format === "env-var" && v !== "" && !ENV_VAR_NAME_PATTERN.test(v)) {
    return err("must be the name of an environment variable (letters, digits, _), not the secret itself");
  }
  if (field.format === "uri" && v !== "" && !URL.canParse(v)) return err("must be a URL");
  return [];
}

/**
 * Load-time check of one source's settings (daemon/plugins/loader.ts): problems
 * with its schema, then with its block of `entryConfig`, as log-ready messages.
 * Empty when it declares no schema or all is well. Never refuses anything.
 */
export function sourceConfigWarnings(source: WorkSource, entryConfig: Readonly<Record<string, unknown>>): string[] {
  if (source.configSchema === undefined) return [];
  const schemaProblems = checkConfigSchema(source.configSchema);
  if (schemaProblems.length) return schemaProblems;
  const where = configScopeOf(source) === "source" ? `config["${source.id}"]` : "config";
  return validateSourceConfig(source.configSchema, sourceConfigBlock(source, entryConfig))
    .map((e) => `${where}${e.path ? `.${e.path}` : ""}: ${e.message}`);
}
