/**
 * HelpPage — Renders the user guide compiled from GUIDE.md at build time.
 */

import guideContent from "@/content/guide.md?raw";
import { MarkdownView } from "@/components/ui/markdown-view";
import { BookOpen } from "lucide-react";

export function HelpPage() {
  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <BookOpen className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Help</h1>
      </div>
      <MarkdownView content={guideContent} />
    </div>
  );
}
