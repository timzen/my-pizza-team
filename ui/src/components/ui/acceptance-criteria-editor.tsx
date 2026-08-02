/**
 * AcceptanceCriteriaEditor — Build acceptance criteria as a running list of
 * items (like the scratchpad's "Add a todo…") instead of one free-text blob.
 *
 * Round-trips a markdown bullet list: the `value` is markdown (e.g.
 * "- The API MUST …\n- It SHOULD …") and `onChange` emits the same, so it drops
 * into any field that stores markdown. Each item is scored against RFC 2119
 * (https://datatracker.ietf.org/doc/html/rfc2119): normative keywords make a
 * criterion testable, so we surface a small strength badge — green (normative),
 * amber (recommended), blue (optional), or red (vague) — nudging the author
 * toward MUST / SHALL / SHOULD / MAY, uppercase per the RFC's convention.
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

// ─── RFC 2119 scoring ──────────────────────────────────────────────

type Level = "normative" | "recommended" | "optional" | "vague";

// Multi-word phrases must be tested before their single-word substrings.
const NORMATIVE = ["MUST NOT", "SHALL NOT", "MUST", "SHALL", "REQUIRED"];
const RECOMMENDED = ["SHOULD NOT", "NOT RECOMMENDED", "SHOULD", "RECOMMENDED"];
const OPTIONAL = ["MAY", "OPTIONAL"];
const ALL_KEYWORDS = [...NORMATIVE, ...RECOMMENDED, ...OPTIONAL];

/** Whole-word, case-sensitive match (RFC 2119 keywords only count in caps). */
function hasKeyword(text: string, kw: string): boolean {
  return new RegExp(`\\b${kw.replace(/ /g, "\\s+")}\\b`).test(text);
}

interface Score {
  level: Level;
  label: string;
  hint?: string;
}

function scoreCriterion(text: string): Score {
  if (NORMATIVE.some((k) => hasKeyword(text, k))) return { level: "normative", label: "normative" };
  if (RECOMMENDED.some((k) => hasKeyword(text, k))) return { level: "recommended", label: "recommended" };
  if (OPTIONAL.some((k) => hasKeyword(text, k))) return { level: "optional", label: "optional" };
  // A lowercase keyword is likely intended as normative — nudge to capitalize.
  const lowered = ` ${text.toLowerCase()} `;
  if (ALL_KEYWORDS.some((k) => lowered.includes(` ${k.toLowerCase()} `))) {
    return { level: "vague", label: "vague", hint: "Capitalize the keyword (MUST / SHOULD / MAY) to make it normative — RFC 2119." };
  }
  return { level: "vague", label: "vague", hint: "Use an RFC 2119 keyword (MUST / SHOULD / MAY) so this is testable." };
}

const BADGE: Record<Level, string> = {
  normative: "bg-green-500/15 text-green-600 border-green-500/40",
  recommended: "bg-amber-500/15 text-amber-600 border-amber-500/40",
  optional: "bg-blue-500/15 text-blue-600 border-blue-500/40",
  vague: "bg-destructive/15 text-destructive border-destructive/40",
};

// ─── markdown <-> items ────────────────────────────────────────────

/** Parse a markdown bullet list into items (tolerates plain lines too). */
function parseItems(md: string): string[] {
  return md
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

/** Serialize items back to a markdown bullet list. */
function toMarkdown(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

export function AcceptanceCriteriaEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (markdown: string) => void;
}) {
  const items = parseItems(value);
  const [draft, setDraft] = useState("");

  const commit = (next: string[]) => onChange(toMarkdown(next));

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    commit([...items, v]);
    setDraft("");
  };

  const remove = (i: number) => commit(items.filter((_, idx) => idx !== i));

  const edit = (i: number, text: string) => {
    const next = [...items];
    next[i] = text;
    onChange(toMarkdown(next)); // keep raw (may be empty mid-edit); trimmed on parse
  };

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {items.map((item, i) => {
          const score = scoreCriterion(item);
          return (
            <li key={i} className="group flex items-center gap-2">
              <Input
                value={item}
                onChange={(e) => edit(i, e.target.value)}
                className="flex-1"
              />
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${BADGE[score.level]}`}
                title={score.hint ?? `Aligns with RFC 2119 (${score.label})`}
              >
                {score.label}
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            placeholder="Add a criterion… (e.g. The endpoint MUST return 401 when unauthenticated)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            className={draft.trim() ? "pr-24" : undefined}
          />
          {draft.trim() && (() => {
            const score = scoreCriterion(draft);
            return (
              <span
                className={`absolute right-2 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] font-medium ${BADGE[score.level]}`}
                title={score.hint ?? `Aligns with RFC 2119 (${score.label})`}
              >
                {score.label}
              </span>
            );
          })()}
        </div>
        <Button type="button" size="icon" className="shrink-0" onClick={add} disabled={!draft.trim()} title="Add criterion">
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Phrase each as a testable requirement. RFC 2119 keywords (MUST, SHALL, SHOULD, MAY — uppercase) make intent unambiguous.
      </p>
    </div>
  );
}
