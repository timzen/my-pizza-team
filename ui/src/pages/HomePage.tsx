/**
 * HomePage — Dashboard with status summary cards and quick actions.
 */

import { useApi } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, BookOpen, CheckCircle, Inbox, Users } from "lucide-react";
import { Link } from "react-router-dom";

interface StatusData {
  running: boolean;
  stories: { total: number; open: number; done: number };
  tasks: { total: number; byStatus: Record<string, number> };
  members: { total: number; working: number; idle: number };
  inbox: number;
}

export function HomePage() {
  const { data, loading } = useApi<StatusData>("/api/status");

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="container mx-auto p-6 text-muted-foreground">Cannot connect to daemon.</div>;

  const stats = [
    { label: "Stories", value: `${data.stories.open} open / ${data.stories.total}`, icon: BookOpen, color: "text-blue-500" },
    { label: "Tasks", value: `${data.tasks.total}`, icon: Activity, color: "text-green-500", sub: Object.entries(data.tasks.byStatus).map(([k, v]) => `${k}: ${v}`).join(", ") },
    { label: "Team", value: `${data.members.total} members`, icon: Users, color: "text-purple-500", sub: `${data.members.working} working, ${data.members.idle} idle` },
    { label: "Inbox", value: `${data.inbox}`, icon: Inbox, color: data.inbox > 0 ? "text-orange-500" : "text-muted-foreground" },
  ];

  return (
    <div className="container mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <stat.icon className={`h-8 w-8 ${stat.color}`} />
                <div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="text-xl font-semibold">{stat.value}</p>
                  {stat.sub && <p className="text-xs text-muted-foreground">{stat.sub}</p>}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {data.stories.done > 0 && (
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <span className="text-sm">{data.stories.done} completed stories ready to <Link to="/archived" className="underline">archive</Link>.</span>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3 text-sm">
        <Link to="/board" className="text-primary underline">Board →</Link>
        <Link to="/team" className="text-primary underline">Team →</Link>
        <Link to="/memory" className="text-primary underline">Memory →</Link>
        <Link to="/config" className="text-primary underline">Config →</Link>
      </div>
    </div>
  );
}
