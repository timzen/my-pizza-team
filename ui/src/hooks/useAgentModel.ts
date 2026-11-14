/**
 * useAgentModel — One agent's model state and the way to change it
 * (docs/DESIGN.md "Choosing a Model"), shared by the teammate page's model chip
 * (components/team/ModelChip) and the Assistant card's model picker
 * (components/config/AssistantSettings).
 *
 * Polls GET /api/agents/:id/model — every second while a switch it asked for is
 * pending, every 5 s otherwise. `pick(model | null)` posts a `set-model`
 * (POST /api/agents/:id/model; null clears the pin) and remembers its
 * directive; when the agent reports it done, that is announced once, and a
 * failure is kept in `error` (the agent's reason) for a FormError to show. A
 * harness that can't switch models answers 409 `unsupported`, shown as "not
 * supported by this harness".
 */

import { useEffect, useRef, useState } from "react";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { changeOutcome, modelLabel } from "@/lib/models";
import type { AgentModelResponse, SetAgentModelResponse } from "@shared/protocol";

export function useAgentModel(id: string | null, name: string) {
  // The last switch asked for from this page, until the next one.
  const [asked, setAsked] = useState<{ directiveId: string; label: string; model: string | null } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const url = id ? `/api/agents/${encodeURIComponent(id)}/model` : null;
  // Poll fast while the switch asked for is pending (derived from the last answer).
  const [polling, setPolling] = useState(false);
  const { data: state, refetch } = useApi<AgentModelResponse>(url, [id], { pollInterval: polling ? 1000 : 5000 });
  const outcome = asked ? changeOutcome(state?.lastChange, asked.directiveId) : null;
  const waiting = !!asked && !outcome;
  if (polling !== waiting) setPolling(waiting);

  // The switch we asked for, once the agent has reported it: say it's done, once.
  // (A failure is the FormError's to announce: `error` below.)
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!asked || !outcome || reported.current === asked.directiveId) return;
    reported.current = asked.directiveId;
    if ("done" in outcome) announce(`${name} switched to ${asked.label}`);
  }, [asked, outcome, announce, name]);

  /** Ask the agent to switch to `model` (null clears the pin). */
  const pick = async (model: string | null) => {
    if (!url || busy) return;
    setBusy(true);
    setRequestError(null);
    const label = model === null ? "its default model" : modelLabel(model, state?.models);
    try {
      const res = await apiPost<SetAgentModelResponse>(url, { model });
      if (res.success && res.directive) {
        setAsked({ directiveId: res.directive.id, label, model });
        announce(model === null ? `Clearing ${name}'s model pin after its current run` : `Switching ${name} to ${label} after its current run`);
      } else {
        setRequestError(res.error || "Couldn't ask it to switch");
      }
      await refetch();
    } finally { setBusy(false); }
  };

  const error = requestError ?? (outcome && "error" in outcome ? `Couldn't switch to ${asked!.label}: ${outcome.error}` : null);
  return {
    state: state ?? null, pick, busy,
    /** The pending switch's label ("Acme Strong"), or null when nothing asked from here is pending. */
    pending: waiting ? asked!.label : null,
    /** The pending switch's model ref (null: clearing the pin) — what a picker shows selected meanwhile. */
    pendingModel: waiting ? asked!.model : null,
    error, refetch,
  };
}
