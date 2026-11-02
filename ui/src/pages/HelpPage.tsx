/**
 * HelpPage — Renders the user guide: the topic pages of docs/guide/, copied
 * into src/content/guide/ by the UI's `prebuild` and bundled at build time, in
 * reading order on one page (lib/guide.ts).
 */

import { MarkdownView } from "@/components/ui/markdown-view";
import { guideMarkdown } from "@/lib/guide";
import { BookOpen } from "lucide-react";

/** Every guide page, as raw markdown keyed by its path (Vite inlines them at build time). */
const GUIDE_MODULES = import.meta.glob<string>("../content/guide/*.md", { query: "?raw", import: "default", eager: true });

/** Built once: the pages never change while the app runs. */
const GUIDE = guideMarkdown(GUIDE_MODULES);

export function HelpPage() {
  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <BookOpen className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Help</h1>
      </div>
      <MarkdownView content={GUIDE} />
    </div>
  );
}
