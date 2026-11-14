/**
 * PageHelpButton — The ? in a page's header: opens the side dock's Help panel
 * on the guide section for this page (lib/help.ts `helpForPath`), or closes it
 * when it's already showing that (docs/DESIGN.md "Help Comes to You").
 *
 * Every desktop page's header has one (TabbedPageLayout puts it on the Work
 * and Config tabs and the detail pages; the others place it themselves). The
 * `?` key does the same from anywhere (components/dock/SideDockProvider). The
 * phone view has no dock: its header's ? goes to the section's page under
 * `/m/help` instead (mobile/MobileShell), so outside a SideDockProvider (a
 * desktop page the phone view reuses, like `/m/teammates/:id`) it renders
 * nothing.
 */

import { HelpCircle } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useContext } from "react";
import { SideDockContext } from "@/hooks/useSideDock";
import { HELP_SHORTCUT } from "@/lib/help";

export function PageHelpButton({ className = "" }: { className?: string }) {
  const dock = useContext(SideDockContext);
  if (!dock) return null;
  const { pageHelp, help, helpOpen, openHelp, closeHelp } = dock;
  const showing = helpOpen && help.topic === pageHelp.topic && help.anchor === pageHelp.anchor;
  return (
    <IconButton
      size="icon-sm"
      className={`shrink-0 text-muted-foreground ${showing ? "bg-accent text-accent-foreground" : ""} ${className}`}
      onClick={() => (showing ? closeHelp() : openHelp())}
      label={`Help for ${pageHelp.page}`}
      hint={`Help for ${pageHelp.page} (${HELP_SHORTCUT})`}
      aria-expanded={showing}
      aria-keyshortcuts={HELP_SHORTCUT}
    >
      <HelpCircle className="h-4 w-4" />
    </IconButton>
  );
}
