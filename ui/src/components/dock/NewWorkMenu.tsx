/**
 * NewWorkMenu — The dock header's `+`: start a piece of work (Story, Solitary
 * task, Scheduled job).
 *
 * It sits immediately left of the queue summary on purpose — `+ | Queue …` reads
 * as "add work to the queue", which is what creating work does. Replaced the
 * "Start work" button row that used to sit at the bottom of the dock (under the
 * chat composer).
 */

import { useNavigate } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { START_WORK } from "@/lib/start-work";
import { Plus } from "lucide-react";

export function NewWorkMenu() {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-accent"
        title="Start work (adds to the queue)"
        aria-label="Start work"
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        {START_WORK.map((item) => (
          <DropdownMenuItem key={item.to} onClick={() => navigate(item.to)}>
            <item.icon className="h-4 w-4" />{item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
