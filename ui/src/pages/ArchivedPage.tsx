/**
 * ArchivedPage — Shows archived stories with their synopses. Presented as a
 * tab of the Board surface (see BoardTabs).
 */

import { useApi } from "@/hooks/useApi";
import { BoardTabs } from "@/components/board/BoardTabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
    <div className="container mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <BoardTabs />
        <div className="text-sm text-muted-foreground">
          {stories.length} {stories.length === 1 ? "story" : "stories"}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Completed stories preserved for reference.</p>

      <div className="space-y-3 max-w-3xl">
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
