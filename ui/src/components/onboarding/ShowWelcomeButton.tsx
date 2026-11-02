/**
 * ShowWelcomeButton — Help's "Show the Welcome checklist": reopen the first-run
 * card (`POST /api/onboarding/reopen`, hooks/useOnboarding `reopenWelcome`)
 * and go to where it's shown — Home on the desktop, the Team tab on the phone
 * (docs/DESIGN.md "First run: a checklist, not a tour"). It works for a team
 * that dismissed the card, finished it, or has enough history never to have
 * seen it. In the dock's Help panel (components/help/HelpPanel) and on the
 * Help page's sidebar (pages/HelpPage).
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListChecks } from "lucide-react";
import { reopenWelcome } from "@/hooks/useOnboarding";
import { useAnnounce } from "@/hooks/useAnnounce";
import { MOBILE_ROOT } from "@/lib/mobile";
import { cn } from "@/lib/utils";

export function ShowWelcomeButton({ phone = false, className }: { phone?: boolean; className?: string }) {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    const ok = await reopenWelcome();
    setBusy(false);
    if (!ok) { announce("Couldn't reopen the Welcome checklist", "assertive"); return; }
    announce(phone ? "Welcome checklist reopened on the Team tab." : "Welcome checklist reopened on Home.");
    navigate(phone ? MOBILE_ROOT : "/");
  };
  return (
    <button
      type="button"
      onClick={show}
      disabled={busy}
      className={cn("flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-accent/50 hover:underline disabled:opacity-50", className)}
    >
      <ListChecks className="h-3.5 w-3.5" aria-hidden />Show the Welcome checklist
    </button>
  );
}
