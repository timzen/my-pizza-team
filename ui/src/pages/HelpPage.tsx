/**
 * HelpPage — Renders the user guide fetched from the daemon.
 * The guide content is a GUIDE.md file served via GET /api/guide.
 */

import { useApi } from "@/hooks/useApi";
import { MarkdownView } from "@/components/ui/markdown-view";
import { BookOpen } from "lucide-react";

export function HelpPage() {
  const { data, loading } = useApi<{ content: string }>("/api/guide");

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <BookOpen className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Help</h1>
      </div>
      {data?.content ? (
        <MarkdownView content={data.content} />
      ) : (
        <p className="text-muted-foreground">No guide available.</p>
      )}
    </div>
  );
}
