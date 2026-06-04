/**
 * AssistantPage — Assistant queue management (enqueue, claim, complete, delete).
 */

import { useState } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";

interface QueueItem {
  id: string;
  prompt: string;
  status: string;
  result?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  processing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  done: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export function AssistantPage() {
  const { data, refetch } = useApi<{ items: QueueItem[] }>("/api/assistant/queue");
  const [prompt, setPrompt] = useState("");

  const items = data?.items || [];

  const handleEnqueue = async () => {
    if (!prompt.trim()) return;
    await apiPost("/api/assistant/queue", { prompt });
    setPrompt("");
    refetch();
  };

  const handleDelete = async (id: string) => {
    await apiDelete(`/api/assistant/queue/${id}`);
    refetch();
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">Assistant Queue</h1>

      {/* Enqueue */}
      <div className="flex gap-2">
        <Textarea
          placeholder="Enter a prompt for the assistant..."
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={2}
          className="flex-1"
        />
        <Button onClick={handleEnqueue} disabled={!prompt.trim()} className="self-end">
          <Plus className="h-4 w-4 mr-1" />Queue
        </Button>
      </div>

      {/* Queue items */}
      <div className="space-y-2">
        {items.map(item => (
          <Card key={item.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className={`text-xs ${STATUS_COLORS[item.status] || ""}`}>
                      {item.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-sm">{item.prompt}</p>
                  {item.result && (
                    <pre className="text-xs bg-muted p-2 rounded mt-2 whitespace-pre-wrap max-h-32 overflow-y-auto">{item.result}</pre>
                  )}
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleDelete(item.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {items.length === 0 && <p className="text-center text-muted-foreground py-8">Queue is empty.</p>}
      </div>
    </div>
  );
}
