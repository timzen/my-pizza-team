/**
 * TeamPage — Team members, their status, and current assignments.
 */

import { useApi } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

interface TeamMember {
  id: string;
  name: string;
  status: string;
  currentTask: string | null;
  tmuxWindow: string;
  lastHeartbeat: number;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "bg-muted text-muted-foreground",
  working: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  pairing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  offline: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export function TeamPage() {
  const { data } = useApi<{ members: TeamMember[] }>("/api/team");
  const members = data?.members || [];

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Users className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Team</h1>
      </div>

      <div className="space-y-2">
        {members.map(member => (
          <Card key={member.id}>
            <CardContent className="p-4 flex items-center gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{member.name}</p>
                  <Badge variant="secondary" className={`text-xs ${STATUS_COLORS[member.status] || ""}`}>
                    {member.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex gap-3">
                  <span>tmux: {member.tmuxWindow}</span>
                  {member.currentTask && <span>task: <strong>{member.currentTask}</strong></span>}
                  <span>heartbeat: {new Date(member.lastHeartbeat).toLocaleTimeString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {members.length === 0 && (
          <p className="text-center text-muted-foreground py-8">No team members registered. Spawn a teammate from the Board page.</p>
        )}
      </div>
    </div>
  );
}
