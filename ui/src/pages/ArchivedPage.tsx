/**
 * ArchivedPage — Work Items → Archived (`/work-items/archived`): retired work
 * across kinds, one section per kind, each hidden while its kind is switched
 * off (hooks/useFeatures):
 * - **Stories** — archived stories with their synopses (`/api/archived`).
 * - **Tasks** / **Schedules** — archived Solitary and Scheduled WorkDefs
 *   (`/api/work-defs?status=archived`), with **Restore** (back to its tab) and
 *   **Delete**. These used to be the Tasks and Schedule pages' Archived drawers;
 *   those pages now list active work only.
 *
 * `/archived` redirects here.
 */

import type { ReactNode } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { useFeatures } from "@/hooks/useFeatures";
import { WorkItemsTabs } from "@/components/WorkItemsTabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArchiveRestore, Trash2 } from "lucide-react";

interface ArchivedStory {
  id: string;
  title: string;
  archivedAt: string;
  synopsis: string;
}

interface ArchivedWorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
}

export function ArchivedPage() {
  const features = useFeatures();
  return (
    <div className="container mx-auto p-4 space-y-4">
      <WorkItemsTabs />
      <p className="text-sm text-muted-foreground">Retired work, preserved for reference.</p>
      {features?.stories && <ArchivedStories />}
      {(features?.tasks || features?.schedules) && <ArchivedWorkDefs tasks={features.tasks} schedules={features.schedules} />}
    </div>
  );
}

/** A titled section of the Archived tab. */
function ArchivedSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 max-w-3xl">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

/** Archived stories with their synopses. */
function ArchivedStories() {
  const { data } = useApi<{ stories: ArchivedStory[] }>("/api/archived");
  const stories = data?.stories || [];
  return (
    <ArchivedSection title="Stories">
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
      {stories.length === 0 && <p className="text-sm text-muted-foreground">No archived stories.</p>}
    </ArchivedSection>
  );
}

/** Archived Solitary tasks and scheduled jobs, one section each, with Restore / Delete. */
function ArchivedWorkDefs({ tasks, schedules }: { tasks: boolean; schedules: boolean }) {
  const { data, refetch } = useApi<{ workDefs: ArchivedWorkDef[] }>("/api/work-defs?status=archived", [], { pollInterval: 30_000 });
  const defs = data?.workDefs || [];

  const restore = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/restore`, {});
    refetch();
  };
  const remove = async (id: string) => {
    await apiDelete(`/api/work-defs/${encodeURIComponent(id)}`);
    refetch();
  };

  const section = (title: string, type: ArchivedWorkDef["type"], empty: string) => {
    const rows = defs.filter(d => d.type === type);
    return (
      <ArchivedSection title={title}>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}
        {rows.map(def => (
          <div key={def.id} className="flex items-center gap-2 rounded-md border p-3">
            <p className="min-w-0 flex-1 text-sm font-medium truncate">{def.title}</p>
            <button onClick={() => restore(def.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"><ArchiveRestore className="h-3 w-3" /> Restore</button>
            <button onClick={() => remove(def.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent text-destructive"><Trash2 className="h-3 w-3" /> Delete</button>
          </div>
        ))}
      </ArchivedSection>
    );
  };

  return (
    <>
      {tasks && section("Tasks", "Solitary", "No archived tasks.")}
      {schedules && section("Schedules", "Scheduled", "No archived scheduled jobs.")}
    </>
  );
}
