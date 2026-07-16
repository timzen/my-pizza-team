/**
 * ContextSelector — Multi-select of context-library entries (toggle chips).
 *
 * Used to attach context entries to stories and tasks. The collection is small,
 * so it renders every entry as a toggle chip (title, with description tooltip).
 * Selection is a list of entry ids. Renders nothing but a hint when the library
 * is empty.
 */

import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";

interface ContextEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
}

interface ContextSelectorProps {
  value: string[];
  onChange: (ids: string[]) => void;
}

export function ContextSelector({ value, onChange }: ContextSelectorProps) {
  const { data } = useApi<{ entries: ContextEntry[] }>("/api/context");
  const entries = data?.entries || [];

  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  };

  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No context entries yet — add some on the Context page.</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((e) => (
        <Button
          key={e.id}
          type="button"
          size="sm"
          variant={value.includes(e.id) ? "default" : "outline"}
          className="text-xs h-7"
          title={e.description || e.title}
          onClick={() => toggle(e.id)}
        >
          {e.title}
        </Button>
      ))}
    </div>
  );
}
