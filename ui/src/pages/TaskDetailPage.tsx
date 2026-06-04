/**
 * TaskDetailPage — Shows task details, messages, and diff/review viewer.
 */

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Send } from "lucide-react";

interface Message {
  from: string;
  body: string;
  at: string;
  attachments?: Array<{ name: string; size: number; type: string }>;
}

interface TaskData {
  id: string;
  seq: number;
  title: string;
  status: string;
  description?: string;
  assignee: string | null;
  hasMessages: boolean;
}

interface StoryView {
  id: string;
  title: string;
  tasks: TaskData[];
}

export function TaskDetailPage() {
  const { storyId, taskId } = useParams<{ storyId: string; taskId: string }>();
  const { data: storiesData } = useApi<{ stories: StoryView[] }>("/api/stories");
  const { data: messagesData, refetch: refetchMessages } = useApi<{ messages: Message[] }>(`/api/tasks/${taskId}/messages`);
  const [newMessage, setNewMessage] = useState("");

  const story = storiesData?.stories.find(s => s.id === storyId);
  const task = story?.tasks.find(t => t.id === taskId);
  const messages = messagesData?.messages || [];

  const sendMessage = async () => {
    if (!newMessage.trim() || !taskId) return;
    await apiPost(`/api/tasks/${taskId}/message`, { from: "lead", body: newMessage });
    setNewMessage("");
    refetchMessages();
  };

  const markRead = async () => {
    if (!taskId) return;
    await apiPost(`/api/tasks/${taskId}/mark-read`);
  };

  if (!task) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Task not found. <Link to="/board" className="underline">Back to board</Link></p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <Link to="/board" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to board
      </Link>

      {/* Task header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-xl font-bold">{task.title}</h1>
          <Badge variant="secondary">{task.status.replace(/_/g, " ")}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{taskId} • Story: {storyId}</p>
        {task.assignee && <p className="text-sm mt-1">Assigned to: <strong>{task.assignee}</strong></p>}
      </div>

      {/* Description */}
      {task.description && (
        <Card>
          <CardContent className="p-4 prose prose-sm dark:prose-invert max-w-none">
            <pre className="whitespace-pre-wrap text-sm font-mono">{task.description}</pre>
          </CardContent>
        </Card>
      )}

      {/* Messages */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Messages ({messages.length})</h2>
          <Button variant="ghost" size="sm" onClick={markRead}>Mark read</Button>
        </div>

        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {messages.map((msg, i) => (
            <Card key={i} className={msg.from === "lead" ? "border-l-4 border-l-primary" : ""}>
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium">{msg.from}</span>
                  <span className="text-xs text-muted-foreground">{new Date(msg.at).toLocaleString()}</span>
                </div>
                <div className="text-sm whitespace-pre-wrap">{msg.body}</div>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mt-2 flex gap-2 flex-wrap">
                    {msg.attachments.map((att, j) => (
                      <Badge key={j} variant="outline" className="text-xs">{att.name} ({att.type})</Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          {messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
        </div>

        {/* Send message */}
        <div className="flex gap-2">
          <Textarea
            placeholder="Send a message as lead..."
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            rows={2}
            className="flex-1"
            onKeyDown={e => { if (e.key === "Enter" && e.metaKey) sendMessage(); }}
          />
          <Button onClick={sendMessage} disabled={!newMessage.trim()} className="self-end">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
