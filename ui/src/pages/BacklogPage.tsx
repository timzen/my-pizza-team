/**
 * BacklogPage — Shows backlogged stories with restore action.
 */

import { useApi, apiPost } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";

interface BacklogStory {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  backloggedAt?: string;
}

export function BacklogPage() {
  const { data, refetch } = useApi<{ stories: BacklogStory[] }>("/api/backlog");
  const stories = data?.stories || [];

  const handleRestore = async (id: string) => {
    if (!confirm(`Restore "${id}" to active board?`)) return;
    await apiPost(`/api/backlog/${id}/restore`);
    refetch();
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">Backlog</h1>
      <p className="text-sm text-muted-foreground">Stories moved off the active board. Restore them when ready.</p>

      <div className="space-y-2">
        {stories.map(story => (
          <Card key={story.id}>
            <CardContent className="p-4 flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="font-medium">{story.title}</p>
                <p className="text-sm text-muted-foreground mt-1">{story.description.slice(0, 150)}</p>
                <div className="flex gap-2 mt-2 text-xs text-muted-foreground">
                  <span>{story.id}</span>
                  {story.backloggedAt && <span>• backlogged {new Date(story.backloggedAt).toLocaleDateString()}</span>}
                  {story.dependsOn.length > 0 && <Badge variant="outline" className="text-xs">deps: {story.dependsOn.join(", ")}</Badge>}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => handleRestore(story.id)}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" />Restore
              </Button>
            </CardContent>
          </Card>
        ))}
        {stories.length === 0 && <p className="text-center text-muted-foreground py-8">Backlog is empty.</p>}
      </div>
    </div>
  );
}
