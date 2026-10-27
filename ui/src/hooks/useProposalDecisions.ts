/**
 * useProposalDecisions — The Accept / Edit / Reject state every triage view
 * shares (pages/TriagePage for a note, components/triage/MirrorTriagePanel for a
 * triage-mode external item): one request at a time, the last error, and which
 * proposal's Edit form is open. The caller says where a decision is posted, since
 * a note's proposals live under `/api/thoughts/:id/…` and a mirror's under
 * `/api/work-defs/:id/triage/…` (docs/DESIGN.md "Auto Triage", "Triage mode").
 */

import { useState } from "react";
import { apiPost } from "@/hooks/useApi";
import type { TriageProposal } from "@/lib/triage";

export interface ProposalDecisions {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
  /** The proposal whose Edit form is open, if any. */
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** Accept (optionally with the Edit form's changes as overrides), or reject. */
  decide: (proposalId: string, action: "accept" | "reject", overrides?: Partial<TriageProposal>) => Promise<void>;
}

/**
 * Decision state for one triage subject. `decisionUrl` builds the accept/reject
 * URL for a proposal; `onDecided` refetches the view after a success.
 */
export function useProposalDecisions(
  decisionUrl: (proposalId: string, action: "accept" | "reject") => string,
  onDecided: () => void,
): ProposalDecisions {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const decide = async (proposalId: string, action: "accept" | "reject", overrides?: Partial<TriageProposal>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await apiPost<{ success: boolean; error?: string }>(
      decisionUrl(proposalId, action),
      overrides ? { overrides } : {},
    );
    setBusy(false);
    if (!res.success) { setError(res.error || `Could not ${action} that proposal`); return; }
    setEditing(null);
    onDecided();
  };

  return { busy, setBusy, error, setError, editing, setEditing, decide };
}
