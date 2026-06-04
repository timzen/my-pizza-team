/**
 * ArchivedPage — Shows archived stories with their synopses.
 */

import { useApi } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Archive } from "lucide-react";

interface ArchivedStory {
  id: string;
  title: string;
  archivedAt: string;
  synopsis: string;
}

export function ArchivedPage() {
  const { data } = useApi<{ stories: ArchivedStory[] }>("/api/archived");
  const stories = data?.stories || [];

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Archive className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Archived Stories</h1>
      </div>
      <p className="text-sm text-muted-foreground">Completed stories preserved for reference.</p>

      <div className="space-y-3">
        {stories.map(story => (
          <Card key={story.id}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <p className="font-medium">{story.title}</p>
                <Badge variant="secondary" className="text-xs">{story.id}</Badge>
                {story.archivedAt && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(story.archivedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              <pre className="text-sm whitespace-pre-wrap text-muted-foreground bg-muted p-3 rounded max-h-48 overflow-y-auto">
                {story.synopsis || "No synopsis available."}
              </pre>
            </CardContent>
          </Card>
        ))}
        {stories.length === 0 && <p className="text-center text-muted-foreground py-8">No archived stories.</p>}
      </div>
    </div>
  );
}
